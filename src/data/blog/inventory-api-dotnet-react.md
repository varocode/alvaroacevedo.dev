---
title: "Construí un sistema de inventario fullstack con .NET 8, React y Postgres — las decisiones que no salen en los tutoriales"
pubDatetime: 2026-05-09T09:00:00-05:00
description: "Sistema fullstack de gestión de inventario con ASP.NET Core 8, React y PostgreSQL. Por qué uso el patrón Result en vez de excepciones, por qué el stock NO se calcula desde los movimientos, y los detalles que separan un CRUD de tutorial de uno de producción."
featured: true
tags:
  - dotnet
  - csharp
  - react
  - postgresql
  - jwt
  - swagger
  - backend
  - fullstack
---

Una API de inventario es el "Hello World" del backend con CRUD. Lo construye todo el mundo — y casi nadie discute las decisiones que aparecen apenas pasas del happy path.

Construí **InventoryAPI**: un sistema fullstack para gestionar productos, categorías, proveedores y movimientos de stock, con dashboard en tiempo real, alertas de stock bajo y autenticación con roles. Backend en **ASP.NET Core 8 + EF Core 8**, frontend en **React 18 + Vite + Tailwind v4**, persistencia en **PostgreSQL** y auth con **JWT + BCrypt**. El código está completo en [github.com/varocode/InventoryAPI](https://github.com/varocode/InventoryAPI).

<img src="/assets/posts/inventory-api/dashboard.png" alt="Dashboard del Inventory Manager mostrando productos totales, stock bajo, valor del inventario, alertas y últimos movimientos" loading="lazy" />

No es el código lo que hace este post interesante — es el *por qué* detrás de algunas decisiones que en un tutorial pasarían inadvertidas: el manejo de errores sin excepciones, el modelo de stock que prefiere denormalizar en vez de derivar, y el costo real de cargar un dashboard con cuatro queries en una sola request.

## Qué quería resolver

La pregunta no era "¿puedo hacer un CRUD?". Era: "¿cómo se ve un CRUD que no me daría vergüenza pasar a un colega senior?".

Eso obliga a pensar en cosas que un tutorial promedio omite:

- ¿Cómo señalo errores de validación al controller sin lanzar excepciones?
- Si tengo `Product.Stock` y una tabla `StockMovements`, ¿cuál es la fuente de verdad?
- ¿Cuándo es razonable un dashboard que dispara N queries en una sola request?
- ¿Qué configuro a nivel de schema para que Postgres no me grite?

## La arquitectura real

El flujo de una operación típica (registrar una salida de stock):

```text
┌──────────────┐                    ┌────────────────────────────────┐
│   React      │   HTTP / JWT       │      ASP.NET Core 8            │
│   (Vite)     │ ─────────────────▶ │                                │
│              │                    │  ┌─────────────────────────┐   │
│  axios       │                    │  │ StockMovementsController│   │
│  (interceptor│ ◀───────────────── │  │ [Authorize]             │   │
│   adjunta    │   200 OK / 400     │  └──────────┬──────────────┘   │
│   Bearer)    │                    │             ▼                  │
└──────────────┘                    │  ┌─────────────────────────┐   │
                                    │  │ StockMovementService    │   │
                                    │  │ valida + actualiza      │   │
                                    │  │ Product.Stock           │   │
                                    │  └──────────┬──────────────┘   │
                                    │             ▼                  │
                                    │       ┌──────────┐             │
                                    │       │EF Core 8 │             │
                                    │       └────┬─────┘             │
                                    └────────────┼───────────────────┘
                                                 ▼
                                          ┌──────────────┐
                                          │  PostgreSQL  │
                                          │  Users       │
                                          │  Products    │
                                          │  Categories  │
                                          │  Suppliers   │
                                          │  Movements   │
                                          └──────────────┘
```

<img src="/assets/posts/inventory-api/products.png" alt="Listado de productos en Inventory Manager con SKU, categoría, proveedor, precio y stock con badges de color según nivel" loading="lazy" />

## El patrón Result que reemplaza las excepciones

Un lugar donde casi todos los tutoriales en .NET tropiezan: usar `throw new Exception("Stock insuficiente")` para señalar que una operación de negocio no es válida.

Lanzar excepciones por **errores esperados** es una forma cara y confusa de devolver "no se pudo". Las excepciones cuestan stack frames, contaminan los logs, y obligan al controller a saber qué tipos atrapar.

`StockMovementService.CreateAsync` devuelve un tuple `(movement, error)`:

```csharp
public async Task<(StockMovementResponseDto? movement, string? error)> CreateAsync(
    CreateStockMovementDto dto)
{
    var product = await db.Products.FindAsync(dto.ProductId);
    if (product is null) return (null, "Producto no encontrado");

    if (dto.Type == "out" && product.Stock < dto.Quantity)
        return (null, $"Stock insuficiente. Disponible: {product.Stock}");

    product.Stock += dto.Type == "in" ? dto.Quantity : -dto.Quantity;

    var movement = new StockMovement
    {
        Type = dto.Type, Quantity = dto.Quantity,
        Reason = dto.Reason, ProductId = dto.ProductId
    };
    db.StockMovements.Add(movement);
    await db.SaveChangesAsync();

    return (new StockMovementResponseDto(...), null);
}
```

Y el controller queda mínimo:

```csharp
[HttpPost]
public async Task<IActionResult> Create(CreateStockMovementDto dto)
{
    var (movement, error) = await stockService.CreateAsync(dto);
    return error is not null
        ? BadRequest(new { message = error })
        : Ok(movement);
}
```

Ventajas concretas:

- **El happy path no tira excepciones.** Las trazas quedan limpias.
- **El controller no inventa exception handlers** para errores de negocio. Solo destructura el tuple.
- **El compilador me ayuda.** Si el servicio cambia y deja de devolver `error`, el tuple deja de tener sentido y la firma rompe el caller — exactamente lo que quiero.

Para errores **inesperados** (DB caída, bug genuino) sigo dejando que la excepción burbujee al middleware global. Los try/catch quedan reservados para lo que de verdad lo merece: I/O externos e integraciones que pueden fallar por razones que no controlo.

## Stock denormalizado: ¿por qué no event sourcing?

`Product.Stock` es la cantidad actual. `StockMovements` registra cada entrada y salida. La pregunta que vale: ¿el stock debería **derivarse** de los movimientos?

En un mundo event-sourced puro, sí: el stock sería `SUM(movements WHERE productId = X)` y `Product.Stock` no existiría como columna. La ventaja: una sola fuente de verdad, perfectamente auditable.

Yo elegí denormalizar. Razones:

1. **Cada lectura de un producto necesita el stock.** Listado, búsqueda, dashboard, alertas. Calcularlo siempre desde los movimientos es un agregado por cada query — caro y barato de evitar con una columna.
2. **El dashboard pide stock bajo en tiempo real.** Filtrar `WHERE Stock <= MinStock` con un índice es directo. Hacerlo con un `HAVING SUM(...) <= MinStock` es escribir SQL más raro de lo necesario.
3. **El audit trail no se rompe.** Los `StockMovements` siguen siendo la historia inmutable de qué pasó. Solo no son la fuente de verdad del estado actual.

El tradeoff: la consistencia entre `Product.Stock` y los movimientos queda en mis manos. La aplicación es la que mantiene la invariante. Por eso `CreateAsync` actualiza ambas cosas en la misma transacción — `SaveChangesAsync` agrupa los cambios en un solo round-trip transaccional.

Si esto creciera a un equipo de 10 personas escribiendo simultáneamente al mismo producto, agregaría un `IsConcurrencyToken()` (o `IsRowVersion()`) a `Product.Stock` para que EF detecte conflictos optimistas. Hoy, con un usuario por vez, alcanza.

## El dashboard: ¿una llamada o muchas?

`GET /api/dashboard` devuelve totales, productos con stock bajo y movimientos recientes en un solo response:

```csharp
public async Task<DashboardDto> GetDashboardAsync()
{
    var products = await db.Products
        .Include(p => p.Category).Include(p => p.Supplier).ToListAsync();
    var lowStock = products.Where(p => p.Stock <= p.MinStock).ToList();
    var recentMovements = await db.StockMovements
        .Include(m => m.Product)
        .OrderByDescending(m => m.Date).Take(10).ToListAsync();

    return new DashboardDto(
        products.Count,
        lowStock.Count,
        await db.Categories.CountAsync(),
        await db.Suppliers.CountAsync(),
        products.Sum(p => p.Price * p.Stock),
        // mapeo de lowStock + recentMovements...
    );
}
```

¿Cuántas queries se disparan? Cuatro al menos: products, recent movements, count categories, count suppliers.

¿Es eso un problema? **Hoy no.** El frontend del dashboard hace una sola llamada y recibe todo lo que necesita pintar. Cuatro queries directas a tablas con índices son baratas; mucho más baratas que cuatro round-trips HTTP desde el cliente.

¿Cuándo lo sería? Cuando `products` empiece a tener decenas de miles de filas y traerlos todos para sumar `Price * Stock` empiece a doler. Ahí muevo la suma al SQL: `await db.Products.SumAsync(p => p.Price * p.Stock)`. Postgres lo resuelve con una agregación, sin materializar la lista en memoria.

La regla que internalicé: **trae lo que vas a usar, calcula en el motor cuando puedas, y no agregues abstracciones para problemas de escala que aún no tienes**.

## Pequeños detalles que importan en producción

Cosas que en una demo no se ven, y en producción te muerden:

### Decimal precision en Postgres

Sin esto, EF Core mete `Price` como `numeric` con precisión por defecto y Npgsql tira un warning en cada migración:

```csharp
modelBuilder.Entity<Product>().Property(p => p.Price).HasPrecision(18, 2);
```

18 dígitos totales, 2 decimales — el rango estándar para money en sistemas serios.

### Unique indexes en Email y SKU

Validaciones a nivel de base de datos. La aplicación puede olvidarse de chequear, la base no:

```csharp
modelBuilder.Entity<User>().HasIndex(u => u.Email).IsUnique();
modelBuilder.Entity<Product>().HasIndex(p => p.SKU).IsUnique();
```

Si dos requests llegan al mismo tiempo intentando crear el mismo email, una de las dos va a fallar con violación de constraint. La app traduce eso a un 409 — pero la integridad ya está garantizada, no depende de un check-then-write con race condition.

### El switch de Npgsql para DateTime

Línea 1 de `Program.cs`:

```csharp
AppContext.SetSwitch("Npgsql.EnableLegacyTimestampBehavior", true);
```

Sin eso, `DateTime.UtcNow` con `timestamp without time zone` revienta en runtime. Es el mismo gotcha que arrastro en cada proyecto .NET con Postgres.

### Role en el JWT desde el día 1

El claim `ClaimTypes.Role` se mete en el token al hacer login:

```csharp
var claims = new[]
{
    new Claim(ClaimTypes.NameIdentifier, user.Id.ToString()),
    new Claim(ClaimTypes.Email, user.Email),
    new Claim(ClaimTypes.Name, user.Name),
    new Claim(ClaimTypes.Role, user.Role)
};
```

Hoy todos los endpoints están protegidos con `[Authorize]` plano (cualquier usuario autenticado). Pero el role ya viaja en el token, así que el día que necesite limitar `DELETE /api/products/{id}` solo a admins, es agregar `[Authorize(Roles = "admin")]` al controller. Sin migration, sin cambios en la DB, sin re-emitir tokens.

### Swagger con security definition

`AddSwaggerGen` está configurado con `Bearer` security scheme. El Swagger UI muestra un botón **Authorize** y todas las operaciones protegidas tienen el candado. Probar la API desde la propia doc se vuelve trivial:

```csharp
c.AddSecurityDefinition("Bearer", new OpenApiSecurityScheme
{
    Description = "JWT Authorization. Ejemplo: Bearer {token}",
    Name = "Authorization",
    In = ParameterLocation.Header,
    Type = SecuritySchemeType.ApiKey,
    Scheme = "Bearer"
});
```

## Lo que haría diferente

- **Concurrency token en `Product.Stock`.** Si dos requests crean salidas simultáneas del mismo producto, ambas pueden pasar la validación `product.Stock < quantity` y el stock terminar negativo. Una columna `RowVersion` con `IsConcurrencyToken()` lo arregla.
- **Mover el cálculo de `inventoryValue` al SQL.** `products.Sum(p => p.Price * p.Stock)` lo hace en memoria. `db.Products.SumAsync(p => p.Price * p.Stock)` lo hace en Postgres. Misma API, costo lineal vs constante en memoria.
- **Paginar `GET /api/products`.** Hoy devuelve la tabla entera. Para inventarios reales (miles de SKUs) hay que paginar con cursor o por número de página.
- **Tests de integración con `WebApplicationFactory`.** El servicio de stock, con la regla "no permitir salidas que dejen stock negativo", pide un test. Faltó.
- **Refresh tokens.** El JWT actual expira a 7 días. Para una app con login real conviene access token corto + refresh token rotando.

## Cierre

El código completo está en [github.com/varocode/InventoryAPI](https://github.com/varocode/InventoryAPI), con setup en 5 minutos: clonas, configuras la connection string a tu Postgres, `dotnet run`. Las migraciones se aplican solas al primer arranque, y Swagger te recibe en `/swagger` con todos los endpoints documentados.

Si te interesa este cruce — **.NET + arquitectura backend pragmática + decisiones honestas en español** — el siguiente post toca testing de integración con `WebApplicationFactory` sobre este mismo proyecto. Suscríbete al [RSS](https://alvaroacevedo.dev/rss.xml) o sígueme en [GitHub](https://github.com/varocode).
