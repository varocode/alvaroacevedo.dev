---
title: "Construí un chat en tiempo real con SignalR, .NET 8 y React — cómo funciona por dentro"
pubDatetime: 2026-05-09T18:00:00-05:00
description: "Construí un chat estilo Discord con SignalR, ASP.NET Core 8, React y PostgreSQL. Comparto la arquitectura real, el ChatHub, cómo autentiqué el WebSocket con JWT y el bug de closures que casi me come."
featured: true
tags:
  - dotnet
  - signalr
  - react
  - postgresql
  - websockets
  - jwt
  - csharp
  - backend
---

Tener una pestaña abierta y ver aparecer mensajes nuevos sin recargar nada es de esos efectos que parecen magia hasta que te toca implementarlos. Detrás hay un WebSocket, un servidor que tiene que recordar quién está conectado, una base de datos que persiste todo, y un montón de detalles que solo aparecen cuando lo armas.

Construí **ChatApp**: un chat en tiempo real, estilo Discord, con canales públicos, panel de usuarios online y mensajes que aparecen al instante. Backend en **ASP.NET Core 8 + SignalR**, frontend en **React 18 + Vite**, persistencia en **PostgreSQL** y autenticación con **JWT + BCrypt**. El código está completo en [github.com/varocode/ChatApp](https://github.com/varocode/ChatApp).

No es un experimento ni un POC: es una pieza completa que ejercita los patrones que aparecen en cualquier sistema con conexiones persistentes — broadcast a grupos, autenticación sobre WebSocket, manejo de estado en el cliente, y closures de React que muerden si no las cuidas.

## Qué quería resolver

La idea era usar SignalR de verdad, no solo invocarlo desde un Hello World. Quería un caso donde **muchos usuarios se conectan al mismo tiempo**, **se suscriben a canales distintos** y **reciben actualizaciones solo del canal donde están**. Eso obliga a entender Groups, autenticación sobre WebSocket, ciclo de vida de la conexión y sincronización con la base de datos.

Y quería el frontend en React, no en Razor Pages ni Blazor. La mayoría del contenido en español sobre SignalR mezcla todo dentro de Microsoft — válido, pero no es lo que quiero practicar. El cruce **React + SignalR** es donde aparecen los problemas más interesantes, especialmente cuando metes JWT y un cliente que cambia de canal.

## La arquitectura real

El flujo de un mensaje, de punta a punta:

```text
┌──────────────┐                    ┌────────────────────────────────┐
│   React      │   WebSocket / JWT  │      ASP.NET Core 8            │
│   (Vite)     │ ─────────────────▶ │                                │
│              │                    │  ┌─────────────────────────┐   │
│  signalR.    │                    │  │   ChatHub               │   │
│  HubConn.    │ ◀───────────────── │  │   - SendMessage         │   │
└──────────────┘   ReceiveMessage   │  │   - JoinRoom/LeaveRoom  │   │
                                    │  │   - OnConnected/Disc.   │   │
                                    │  └──────────┬──────────────┘   │
                                    │             │                  │
                                    │             ▼                  │
                                    │  ┌─────────────────────────┐   │
                                    │  │   MessageService (DI)   │   │
                                    │  └──────────┬──────────────┘   │
                                    │             ▼                  │
                                    │       ┌──────────┐             │
                                    │       │EF Core 8 │             │
                                    │       └────┬─────┘             │
                                    └────────────┼───────────────────┘
                                                 ▼
                                          ┌──────────────┐
                                          │  PostgreSQL  │
                                          └──────────────┘
```

Cuando un usuario manda un mensaje:

1. El cliente llama `connection.invoke('SendMessage', content, roomId)` por WebSocket.
2. El `ChatHub` recibe la llamada, lee el `userId` del JWT, persiste el mensaje vía `MessageService`.
3. El Hub hace broadcast a todos los conectados al grupo `room-{roomId}` con `Clients.Group(...).SendAsync("ReceiveMessage", message)`.
4. Cada cliente suscrito a ese canal recibe el `ReceiveMessage` y lo agrega al estado local.

Lo importante: **el remitente también recibe el evento**, no se hace optimistic update. Una sola fuente de verdad: lo que el servidor confirma. Más simple, menos bugs de "el mensaje aparece dos veces".

## El núcleo: ChatHub.cs

Toda la magia del tiempo real está en este archivo. Es corto a propósito — el Hub es coordinación, no lógica de negocio:

```csharp
[Authorize]
public class ChatHub(MessageService messageService) : Hub
{
    // Suscribe la conexión actual al grupo del canal.
    // Solo recibirá ReceiveMessage de mensajes en ese canal.
    public async Task JoinRoom(int roomId)
    {
        await Groups.AddToGroupAsync(Context.ConnectionId, $"room-{roomId}");
    }

    public async Task LeaveRoom(int roomId)
    {
        await Groups.RemoveFromGroupAsync(Context.ConnectionId, $"room-{roomId}");
    }

    // Persiste el mensaje y lo emite a todos los del grupo.
    public async Task SendMessage(string content, int roomId)
    {
        var userId = int.Parse(Context.User!.FindFirstValue(ClaimTypes.NameIdentifier)!);
        var dto = new SendMessageDto(content, roomId);
        var message = await messageService.CreateAsync(dto, userId);
        await Clients.Group($"room-{roomId}").SendAsync("ReceiveMessage", message);
    }

    public override async Task OnConnectedAsync()
    {
        var username = Context.User!.FindFirstValue(ClaimTypes.Name)!;
        await Clients.All.SendAsync("UserOnline", username);
        await base.OnConnectedAsync();
    }

    public override async Task OnDisconnectedAsync(Exception? exception)
    {
        var username = Context.User!.FindFirstValue(ClaimTypes.Name)!;
        await Clients.All.SendAsync("UserOffline", username);
        await base.OnDisconnectedAsync(exception);
    }
}
```

Tres detalles que vale anotar:

- **`[Authorize]` a nivel de clase.** Sin JWT válido, no hay handshake. SignalR rechaza la conexión antes de que `OnConnectedAsync` se ejecute. No hay forma de "colarse" en el Hub.
- **Grupos como mecanismo de routing.** Convertir `roomId` en `room-{roomId}` y usarlo como nombre de grupo evita que tú mismo trackees qué `connectionId` está en qué canal. SignalR lo hace por ti, y soporta multi-instancia con el backplane (Redis) cuando llegue el momento de escalar.
- **Constructor primario con DI.** `ChatHub(MessageService messageService)` inyecta el servicio sin escribir un constructor explícito. C# 12 limpia mucho ruido, y el Hub es scoped por llamada — cada invocación recibe su propia instancia del servicio.

## JWT sobre WebSocket: el detalle que casi todos pasan por alto

Aquí está la parte que más tiempo me ahorró saber de antemano: **un WebSocket del navegador no puede mandar headers customizados**. Es una limitación de la spec. El típico `Authorization: Bearer <token>` que funciona en HTTP no funciona en el handshake del WebSocket.

La solución estándar de SignalR: pasar el token por query string y leerlo en el evento `OnMessageReceived` del JWT bearer.

```csharp
.AddJwtBearer(opt =>
{
    opt.TokenValidationParameters = new TokenValidationParameters
    {
        ValidateIssuerSigningKey = true,
        IssuerSigningKey = new SymmetricSecurityKey(
            Encoding.UTF8.GetBytes(jwtSecret)),
        ValidateIssuer = true,  ValidIssuer = builder.Configuration["Jwt:Issuer"],
        ValidateAudience = true, ValidAudience = builder.Configuration["Jwt:Audience"],
    };

    opt.Events = new JwtBearerEvents
    {
        OnMessageReceived = ctx =>
        {
            // Solo para rutas del Hub: leer el token del query string
            // (el WebSocket del navegador no puede mandar headers).
            var token = ctx.Request.Query["access_token"];
            if (!string.IsNullOrEmpty(token) &&
                ctx.HttpContext.Request.Path.StartsWithSegments("/hubs"))
                ctx.Token = token;
            return Task.CompletedTask;
        }
    };
});
```

El check `StartsWithSegments("/hubs")` es importante: limita esta lectura solo a las rutas del Hub. Para el resto de los endpoints HTTP, el token sigue viniendo del header `Authorization` como debe ser. Sin esa restricción, expones tu API a tokens viajando en query string que se quedan en logs, en el `Referer` y en el historial del navegador.

Y en el cliente, igual de simple:

```javascript
const conn = new signalR.HubConnectionBuilder()
  .withUrl(`/hubs/chat?access_token=${token}`)
  .withAutomaticReconnect()
  .build()
```

El resto de la API HTTP (rooms, messages, auth) usa el patrón clásico: un interceptor de Axios que mete `Authorization: Bearer <token>` en cada request, y un `[Authorize]` a nivel de controlador.

## El problema que más me costó: el closure que mostraba mensajes en el canal equivocado

Funcionaba todo. JWT, broadcast, persistencia. Cambiaba de canal y los mensajes nuevos seguían apareciendo... en el canal anterior.

El callback de `ReceiveMessage` en React se registra **una sola vez** cuando se crea la conexión. En ese momento captura las variables de su scope — incluyendo `activeRoom`, que es estado de React. Cuando `activeRoom` cambia más tarde, el callback **sigue viendo el valor viejo**. Closure capturado, estado obsoleto.

La fix correcta no es leer el estado dentro del callback (no lo tiene). Es usar un `ref` que sí refleja el valor actual en cada render:

```jsx
const activeRoomRef = useRef(null)
activeRoomRef.current = activeRoom   // se sincroniza en cada render

useEffect(() => {
  const conn = new signalR.HubConnectionBuilder()
    .withUrl(`/hubs/chat?access_token=${token}`)
    .withAutomaticReconnect()
    .build()

  conn.on('ReceiveMessage', msg => {
    // Leer el room actual desde el ref, no desde el closure.
    if (msg.roomId === activeRoomRef.current?.id) {
      setMessages(prev => [...prev, msg])
    }
  })

  conn.start()
  connectionRef.current = conn
  return () => conn.stop()
}, [])  // efecto sin dependencias: la conexión vive una sola vez
```

Dos cosas que vale internalizar:

- Si registras el `useEffect` con `[activeRoom]` como dependencia, el efecto se desmonta y vuelve a montar la conexión cada vez que cambias de canal. Eso reconecta el WebSocket en cada click. Pésimo.
- Si lo dejas sin dependencias y lees `activeRoom` directo, te queda el closure obsoleto y los mensajes aparecen en el lugar equivocado.

El patrón **ref + effect sin dependencias** es la forma idiomática de cruzar el puente entre React (que vive en el modelo declarativo) y librerías imperativas como SignalR (que viven en el modelo de callbacks). Vale aprenderlo bien — vuelve a aparecer con WebSockets crudos, MQTT, MapLibre, cualquier cosa con suscripciones.

## Detalle bonus: Npgsql y las fechas

Línea 1 de `Program.cs`:

```csharp
AppContext.SetSwitch("Npgsql.EnableLegacyTimestampBehavior", true);
```

Sin eso, `DateTime.UtcNow` mezclado con `timestamp without time zone` rompe en runtime con un mensaje confuso sobre `Cannot write DateTime with Kind=UTC...`. Es un cambio de comportamiento entre versiones de Npgsql que solo te encuentras cuando hace `crash` en producción. Lo dejé al inicio del archivo para que se vea — y para acordarme.

## Lo que haría diferente

- **Mensajes en orden ascendente con `OrderByDescending → Take → OrderBy` funciona, pero a escala usaría keyset pagination.** Hoy la query trae los últimos 50 con `ORDER BY createdAt DESC LIMIT 50` y los voltea en memoria. Para canales con miles de mensajes y scroll infinito, paginar por `(createdAt, id) < (cursor)` es más limpio.
- **Online users en memoria del cliente, no en el servidor.** Hoy cada cliente lleva su propia lista basada en `UserOnline` / `UserOffline`. Si te conectas tarde, no sabes quién estaba antes. Mover ese estado a Redis o al menos a una tabla `Connections` con cleanup en `OnDisconnectedAsync` lo arregla.
- **Rate limiting en `SendMessage`.** El Hub no tiene throttling. Un cliente malicioso puede inundar el grupo. `Microsoft.AspNetCore.RateLimiting` o un middleware custom sobre el Hub lo cubre.
- **Tests del Hub.** SignalR tiene `TestServer` y `HubConnection` apuntando a memoria. Faltó armar la suite. Es lo siguiente.

## Cierre

El código está completo en [github.com/varocode/ChatApp](https://github.com/varocode/ChatApp), MIT, con instrucciones de setup en el README. Si lo clonas y lo corres, en cinco minutos tienes el chat funcionando local con tu PostgreSQL.

Si te interesa este cruce — **.NET + tiempo real + arquitectura backend en español** — el siguiente post va a profundizar en el cliente: reconnect, presencia con Redis, y tests con `TestServer`. Suscríbete al [RSS](https://alvaroacevedo.dev/rss.xml) o sígueme en [GitHub](https://github.com/varocode).
