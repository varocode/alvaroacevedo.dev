---
title: "Construí mi primer MCP server en C# y otra IA encontró un bug que mis tests ocultaron"
pubDatetime: 2026-05-05T20:00:00-05:00
description: "Cómo construí mi primer MCP server en .NET 10 para buscar en docs de Microsoft Learn, qué decisiones de arquitectura tomé, y cómo un code review honesto de otra IA me hizo encontrar un bug crítico que mis tests no detectaban."
featured: true
tags:
  - dotnet
  - csharp
  - mcp
  - build-in-public
  - tutorial
---

Este es el segundo post del blog y, fiel al contrato del primero, voy a contarte algo que **construí de verdad, con código real, decisiones reales, y un bug que casi se me escapa**.

Construí un **MCP server en C# / .NET 10** que se llama [`dotnet-docs-mcp`](https://github.com/varocode/dotnet-docs-mcp). Su trabajo es simple: cuando Claude / Cursor / VS Code necesitan información oficial de .NET, este server busca en la API pública de Microsoft Learn y devuelve resultados frescos.

El proceso terminó siendo más interesante de lo que esperaba. Lo construí, lo probé, parecía funcionar perfecto, lo conecté a Claude Code, le pedí a otra sesión de Claude que lo probara como reviewer externo, y **en 2 queries apareció un bug crítico que mis pruebas no habían detectado**.

La solución me llevó a investigar cómo filtrar correctamente la API de Microsoft Learn con OData `$filter`. Al final el v1.1 quedó haciendo lo que prometía desde el nombre.

Te cuento el proceso completo, sin saltarme las partes incómodas.

## Pero ¿no existe ya un MCP oficial de Microsoft Learn?

Sí. Existe. Cuando configuras Claude Code te aparece automáticamente conectado un MCP llamado `claude.ai Microsoft Learn`. Es el oficial de Microsoft, expone `microsoft_docs_search`, `microsoft_code_sample_search` y `microsoft_docs_fetch`. Cubre .NET, Azure, Power Platform, Windows, todo.

Entonces, ¿para qué construir el mío?

Razones que valen la pena:

1. **Aprendizaje real.** Construir es la única forma de entender el protocolo MCP a profundidad. Leer la spec no es lo mismo que escribir un server desde cero.
2. **Customización total.** El oficial es una caja negra. El mío es código abierto que puedo modificar: idioma del output, formato de la respuesta, qué campos mostrar al LLM, qué filtros aplicar, qué estructura tiene cada resultado.
3. **Open source en mi portfolio.** El código de Microsoft no lo puedo mostrar como mío. El de mi server, sí. Está en GitHub bajo licencia MIT.
4. **Independencia.** Si Microsoft decide cambiar el comportamiento, deprecar features, o cobrar por el oficial, yo tengo mi propia implementación.
5. **Base para extender.** El siguiente paso es agregar tools que el oficial no tiene: caching, RAG sobre los resultados, fetch a markdown con limpieza personalizada, etc.

Si lo único que quieres es buscar docs en tu sesión de Claude, usa el oficial. Si quieres **aprender a construir MCPs y tener una base que puedes extender**, construir el tuyo tiene mucho sentido.

## El stack

- **.NET 10.0.104** en mi máquina para este build.
- **`ModelContextProtocol` 1.2.0** desde NuGet — el SDK oficial de C# para MCP. Ya es versión estable, no necesité `--prerelease`.
- **`Microsoft.Extensions.Hosting` 10.0.7** para `Host.CreateApplicationBuilder()` con DI y logging.
- **`Microsoft.Extensions.Http` 10.0.7** para `IHttpClientFactory` y HttpClient tipado.
- **API de Microsoft Learn**: `https://learn.microsoft.com/api/search`, pública sin autenticación.

Sin AOT, sin SSE, sin auth. Lo más simple posible para v1. Si te interesan esas optimizaciones, son material de v2.

## Por qué clean architecture en pequeño

Podía haber escrito todo el server en 50 líneas dentro de un solo `Program.cs`. Funciona, y para un spike de una tarde probablemente sería suficiente.

Pero no quería que esto se quedara como demo desechable. La idea del blog es mostrar **patrones que se usan en producción**, no solo snippets que compilan una vez.

Estructura que terminó quedando:

```text
DotnetDocsMcp/
├── Program.cs                           ← arranque del MCP server (host + DI)
├── Tools/
│   └── DotnetDocsSearchTool.cs          ← la herramienta MCP expuesta
├── Services/
│   ├── IMicrosoftLearnSearch.cs         ← contrato del servicio
│   └── MicrosoftLearnSearchService.cs   ← implementación HTTP
└── Models/
    └── SearchResult.cs                  ← DTOs
```

Separar la **tool** del **servicio** me permite:

- **Testear la búsqueda** independientemente de MCP (con xUnit + WireMock para el HttpClient).
- **Cambiar la fuente** sin tocar la tool. Si mañana quiero usar embeddings locales en lugar de la API de Microsoft Learn, solo cambio la implementación del servicio.
- **Reusar el servicio** en otros contextos: una CLI, una web app, otro MCP server.

Para mí, clean architecture no es una religión ni una excusa para meter 12 proyectos donde bastaba un archivo. Cuando el código no va a crecer, cuando no hay reglas de negocio reales, o cuando todavía estás descubriendo el problema, sobre-architecting puede ser una forma elegante de perder tiempo.

Pero aquí sí había una separación natural: **protocolo MCP por un lado, búsqueda HTTP por otro, DTOs por otro**. Esa línea vale la pena porque me deja probar, reemplazar y extender sin tocar todo. Ese es el punto: no aplicar clean architecture para sonar serio, sino usar la mínima separación que te compra opciones reales.

## Detalles técnicos importantes que casi nadie documenta

Estos son los detalles que me tomaron tiempo descubrir y que valen oro para alguien que arranca con MCP en C#:

### 1. Logging en stdio MCP transport: stdout es sagrado

En MCP con transporte stdio, **`stdout` se reserva exclusivamente para el protocolo JSON-RPC**. Cualquier output a stdout que no sea un mensaje del protocolo **rompe el cliente**: Claude, Cursor o VS Code no van a saber qué hacer con texto suelto, y cierran la conexión.

Por eso en `Program.cs` configuré:

```csharp
builder.Logging.AddConsole(options =>
{
    options.LogToStandardErrorThreshold = LogLevel.Trace;
});
```

Eso fuerza **todos los logs (Trace, Debug, Info, Warn, Error)** a `stderr`, dejando `stdout` limpio para JSON-RPC.

Si te olvidas, el síntoma suele ser:

- El cliente MCP no se conecta.
- Logs misteriosos sobre "invalid JSON received" o disconnect.
- Funciona en pruebas locales con `Console.WriteLine` y rompe en cliente real.

### 2. Naming convention: snake_case automático

El SDK detecta el nombre del método y lo convierte a `snake_case` para el protocolo:

- Método C#: `SearchDotnetDocs(...)`
- Tool name expuesta: `search_dotnet_docs`

No hay que configurar nada manual, pero hay que saberlo cuando otros componentes (logs, debugging, descripción de la tool al LLM) muestran el nombre `snake_case`.

### 3. Auto-generación del inputSchema

El SDK lee los parámetros del método más sus `[Description]` attributes y genera automáticamente el JSON Schema que se expone al LLM:

```csharp
public async Task<string> SearchDotnetDocs(
    [Description("La consulta de búsqueda...")]
    string query,
    [Description("Cuántos resultados devolver...")]
    int top = 5,
    CancellationToken cancellationToken = default)
```

Produce este schema visible al cliente:

```json
{
  "type": "object",
  "properties": {
    "query": { "type": "string", "description": "..." },
    "top": { "type": "integer", "default": 5, "description": "..." }
  },
  "required": ["query"]
}
```

**Nota:** el `CancellationToken` no aparece en el schema. El SDK sabe que es runtime-only y lo inyecta automáticamente.

### 4. Deserialización JSON: case-sensitivity por default

La API de Microsoft Learn devuelve `camelCase` (`title`, `lastUpdatedDate`). Por defecto, `System.Text.Json` es **case-sensitive**, así que sin configurar nada, los records C# en PascalCase quedan con todas las propiedades en `null`.

Solución limpia:

```csharp
private static readonly JsonSerializerOptions JsonOptions = new()
{
    PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
};
```

Mucho mejor que decorar cada propiedad con `[JsonPropertyName]`.

### 5. User-Agent aunque la API no pida auth

La API de Microsoft Learn es pública y no requiere API key, pero igual configuré un `User-Agent` descriptivo:

```csharp
client.DefaultRequestHeaders.UserAgent.ParseAdd(
    "DotnetDocsMcp/1.0 (+https://github.com/varocode/dotnet-docs-mcp)");
```

No es glamoroso, pero es buena práctica con APIs públicas. Si un día hay abuso, rate limits raros o cambios de comportamiento, por lo menos el cliente está identificado.

## El v1: pasó a la primera

Compilé. Cero errores, cero warnings.

Probé el handshake JSON-RPC con un script que mandaba `initialize` por stdin:

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{...}}' \
  | ./bin/Debug/net10.0/DotnetDocsMcp 2>/dev/null
```

Respuesta correcta. `tools/list` también devolvió `search_dotnet_docs` con su schema generado. `tools/call` invocó la API de Microsoft Learn y devolvió resultados formateados.

Y sí: me sorprendió. Cuando estás armando algo con protocolo, stdio, JSON-RPC, DI, un SDK nuevo y un cliente externo, uno casi espera que el primer intento falle por algo absurdo. Me quedé mirando la terminal unos segundos como diciendo: "¿ya? ¿no va a explotar?".

Fue una mezcla rara de alivio y desconfianza. Alivio porque el stack estaba maduro y las decisiones fueron conservadoras. Desconfianza porque un build verde no significa que la herramienta sea buena; solo significa que todavía no encontraste el caso que la rompe.

Ese caso apareció después.

## MCP Inspector: la herramienta oficial para debugging

Para inspeccionar el server visualmente usé `@modelcontextprotocol/inspector`. Desde la raíz del repo:

```bash
npx -y @modelcontextprotocol/inspector ./bin/Debug/net10.0/DotnetDocsMcp
```

Te abre una UI web en `http://localhost:6274` donde puedes:

- Ver el handshake en vivo.
- Listar las tools expuestas con sus schemas.
- Invocar la tool con cualquier argumento.
- Ver las respuestas del server en pretty JSON.
- Ver los logs JSON-RPC que se intercambian.

Es la mejor forma de validar que tu MCP server cumple el protocolo.

### Bug del Inspector v0.21.2 que vale anotar

Si refrescas la pestaña del navegador del Inspector mientras hay una sesión activa, el proxy de Node.js crashea con un `Error: Not connected` no capturado. Después tienes que matar procesos zombies con `pkill -f "modelcontextprotocol/inspector"` y relanzar.

> Workaround: haz click en "Disconnect" en la sidebar antes de cerrar/refrescar la pestaña.

No era bug de mi MCP, era del Inspector. Pero saberlo te puede ahorrar horas.

## Comparación de calidad de resultados con queries reales

Probé varios queries en el Inspector. Los resultados fueron reveladores:

| Query | Idioma | Relevantes/5 | Comentario |
|-------|--------|--------------|------------|
| `como se configura una api web basica en .net` | español natural | **0/5** | Solo páginas índice (.NET docs root, Azure Architecture, Visual Studio docs) |
| `Minimal API tutorial` | inglés keywords | **2-3/5** | Mezcla overviews + relevantes |
| `IAsyncEnumerable performance` | inglés técnico ambiguo | **1/5** ⚠️ | Trajo Azure VM disk types, Edge DevTools — "performance" matchea miles de docs |
| `Semantic Kernel agents` | inglés con entidad nominada única | **5/5** ✅ | Todos relevantes |

**Patrón descubierto:**

> El MCP server era **excelente** cuando la query incluía **nombres propios técnicos únicos** (Semantic Kernel, Agent Framework, Aspire, Blazor, MAUI). Era **mediocre** con queries que incluían palabras técnicas comunes (performance, tutorial, async). Y era **inútil** con queries en español sobre conceptos genéricos.

En este punto pensé que tenía un v1 funcional con limitaciones conocidas. Estaba listo para publicar.

Pero faltaba un test que no había hecho.

## El test que cambió todo: code review por otra IA

Conecté el MCP a Claude Code con `claude mcp add`:

```bash
claude mcp add --scope user dotnet-docs ~/path/al/repo/publish/DotnetDocsMcp
```

Y le pedí a Claude que probara mi server en una sesión normal, como si fuera un usuario real. La respuesta que recibí fue **el feedback más útil del proyecto**.

Le tiró dos queries para probar: una específica (`System.Text.Json JsonSerializerOptions`) y una conceptual (`IAsyncEnumerable cancellation token best practices`).

La primera devolvió todo URLs `/dotnet/...`: how-to, deserialization, polymorphism, converters. 10/10.

**La segunda explotó:**

```text
1. Azure Architecture Center
2. Official Microsoft Power Apps documentation
3. Official Microsoft Power Platform documentation
4. Microsoft Learn resources (página de soporte)
5. Exam SC-100: Microsoft Cybersecurity Architect
```

**Cero resultados de .NET para una query 100% .NET.** `IAsyncEnumerable<T>` es un tipo del BCL. No hay query más .NET que esa.

Y el feedback del review fue brutal y directo:

> El nombre del MCP es `dotnet-docs`. La expectativa del que lo usa es que devuelva docs de .NET. Hoy no cumple ese contrato.

Tenía razón.

## Por qué mis tests no lo detectaron

Mis queries en el Inspector estaban **sesgadas hacia entidades nominadas únicas** (`Semantic Kernel`, `Minimal API`). Cuando una query incluye entidades únicas, el ranking semántico de Microsoft Learn las prioriza y disimula el problema. Pero `IAsyncEnumerable cancellation token best practices` no tiene entidades únicas: son conceptos comunes que matchean docs populares de cualquier producto.

**Lección que vale para cualquier feature, no solo MCPs:**

> Si tus tests usan solo casos cuidadosamente seleccionados, no estás testeando; estás demostrando que tu código funciona en los casos que ya sabes que funcionan. Varía los inputs. Especialmente con inputs conceptuales y ambiguos.

## Investigación: por qué el server no filtraba

El código del v1 usaba este endpoint:

```text
https://learn.microsoft.com/api/search?search={q}&locale=en-us&%24top={n}&category=Documentation
```

`category=Documentation` filtra resultados de tipo "documentación", pero **no filtra por producto**. La API de Microsoft Learn cubre toda Microsoft Learn: .NET, Azure, Power Platform, Office, Windows, certificaciones, todo.

Cuando la query es muy específica, el ranking salva. Cuando no lo es, trae basura.

Probé varios parámetros que parecían razonables:

| Parámetro probado | Resultado |
|-------------------|-----------|
| `products=dotnet` | Ignorado por la API (mismos resultados) |
| `scope=.NET` | Ignorado |
| `$facet=products` | Ignorado, no devolvió facetas. En una URL real `$` puede ir escapado como `%24facet`. |
| `$filter=scopes/any(t:t eq '.NET')` | **¡Funciona!** |

El parámetro correcto es **OData `$filter`** sobre el campo `scopes` (que es un array). La sintaxis `scopes/any(t:t eq '.NET')` significa "cualquier elemento del array `scopes` que sea exactamente `.NET`".

Esto es OData syntax — el estándar que aparece una y otra vez en APIs del ecosistema Microsoft.

## La fix: v1.1 con OData $filter

El cambio en `MicrosoftLearnSearchService.cs`:

```csharp
public async Task<MicrosoftLearnSearchResponse> SearchAsync(
    string query,
    int top = 5,
    string scope = ".NET",  // ← nuevo parámetro
    string locale = "en-us",
    CancellationToken cancellationToken = default)
{
    ArgumentException.ThrowIfNullOrWhiteSpace(query);
    ArgumentException.ThrowIfNullOrWhiteSpace(scope);

    var odataFilter = $"scopes/any(t:t eq '{scope}')";

    var queryParams = new Dictionary<string, string>
    {
        ["search"] = query,
        ["locale"] = locale,
        ["$top"] = top.ToString(),
        ["category"] = "Documentation",
        ["$filter"] = odataFilter,
    };

    var queryString = string.Join("&", queryParams
        .Select(kvp => $"{Uri.EscapeDataString(kvp.Key)}={Uri.EscapeDataString(kvp.Value)}"));

    var requestUrl = $"{BaseEndpoint}?{queryString}";
    // ...
}
```

Y agregué el parámetro `scope` a la tool:

```csharp
public async Task<string> SearchDotnetDocs(
    string query,
    int top = 5,
    string scope = ".NET",  // ← default razonable, configurable
    CancellationToken cancellationToken = default)
```

Aproveché también para mejorar la `[Description]` de la tool con guía de cómo formular queries (después de los hallazgos del testing) y para quitar el `count` global que era engañoso.

## Verificación: 0/5 → 5/5

Misma query problemática (`IAsyncEnumerable cancellation token best practices`), v1.1:

```text
1. .NET documentation - .NET
2. GitHub Copilot modernization overview (.NET)
3. Best practices for exceptions - .NET
4. Cancellation in Managed Threads - .NET   ← perfecto match
5. TLS best practices with .NET Framework
```

**5/5 resultados de .NET.** El MCP ahora cumple el contrato que promete su nombre.

Le mostré la fix a la otra IA y la confirmación fue:

> El MCP ahora cumple el contrato que promete su nombre. Buen arreglo.

## Lecciones del proceso

1. **El nombre de tu API es un contrato.** Si tu MCP se llama `dotnet-docs`, debe devolver docs de .NET. No "todo Microsoft Learn pero filtrado por categoría". Esa diferencia es la que hace que un usuario confíe o no en tu tool.

2. **El feedback externo es oro.** La otra IA encontró en 2 queries lo que yo no vi en 5. Pedir review honesto a otro modelo, otro colega, otra herramienta es parte del proceso, no debilidad.

3. **OData `$filter` en APIs Microsoft.** Cuando una API parece no soportar filtros, probar OData syntax es buena apuesta. En este caso fue la diferencia entre una tool bonita y una tool útil.

4. **Prueba queries variadas.** Específicas, conceptuales, ambiguas, en distintos idiomas. Mis tests sesgados con queries de entidades nominadas me ocultaron el bug.

5. **La `[Description]` de la tool es UX.** Más que un comentario bonito. Es lo que el LLM lee para decidir cuándo invocar la tool y cómo formular la query. Una buena descripción cambia la utilidad real del MCP.

6. **No te enamores del primer green check.** Que compile y responda no significa que cumpla el contrato. El build verde solo abre la puerta al test importante: usarlo en condiciones reales.

7. **Escribe el build log mientras construyes.** Si esperaba al final, se me olvidaban los detalles pequeños: el bug del Inspector, los parámetros que no funcionaron, la sensación de "esto pasó demasiado fácil". El post salió de esas notas, no de memoria perfecta.

8. **El LLM también es usuario de tu API.** En un MCP no diseñas solo para humanos. Diseñas para que un modelo entienda cuándo usar la tool, qué query mandar y qué hacer con la respuesta. Eso cambia cómo piensas nombres, descripciones y output.

## Próximos pasos para el v1.2

- **Agregar `fetch_dotnet_doc(url)`**: una segunda tool que tome una URL y devuelva el contenido completo de la página en markdown. Ahí está el verdadero valor cuando quieres código de ejemplo o pasos completos. La búsqueda te da el qué, el fetch te da el cómo.
- **Caching en memoria con TTL** para queries repetidas.
- **Tests unitarios con xUnit + WireMock** para el HttpClient.
- **Compilación AOT** para distribuir como single binary nativo.

## Cómo usarlo

El código completo está en [github.com/varocode/dotnet-docs-mcp](https://github.com/varocode/dotnet-docs-mcp). El [README](https://github.com/varocode/dotnet-docs-mcp#readme) tiene instrucciones de configuración para Claude Desktop, Claude Code, Cursor y VS Code.

Si tienes .NET 10 instalado, el setup es:

```bash
git clone https://github.com/varocode/dotnet-docs-mcp.git
cd dotnet-docs-mcp
dotnet publish DotnetDocsMcp/DotnetDocsMcp.csproj -c Release -o ./publish
```

Y después agregas el path del binario en la configuración de tu cliente MCP. Listo.

## Cierre

Este es el primer post sobre MCPs en .NET y van a venir varios más. La idea es que la serie crezca a 5-10 servers construidos en C#, cada uno cubriendo un caso de uso real, con su `BUILD_LOG` honesto.

Si te interesa el cruce entre **.NET + IA + arquitectura backend en español**, suscríbete al [RSS](https://alvaroacevedo.dev/rss.xml) o sígueme en [GitHub](https://github.com/varocode). Y si construiste algo similar y quieres intercambiar notas, escríbeme: [alvaroacevedo83@gmail.com](mailto:alvaroacevedo83@gmail.com).

Nos leemos en el próximo.
