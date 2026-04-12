[English](./README.md) | [中文](./README.zh.md) | [한국어](./README.ko.md) | [日本語](./README.ja.md) | Español | [Tiếng Việt](./README.vi.md) | [Português](./README.pt.md)

# Watchdog

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
[![Claude Code](https://img.shields.io/badge/Claude%20Code-2.1%2B-7C4DFF.svg)](https://docs.anthropic.com/claude-code)
[![Version](https://img.shields.io/badge/version-1.2.0-green.svg)](./.claude-plugin/plugin.json)
[![GitHub stars](https://img.shields.io/github/stars/JonyanDunh/claude-code-watchdog?style=flat&color=yellow)](https://github.com/JonyanDunh/claude-code-watchdog/stargazers)
[![Inspired by ralph-loop](https://img.shields.io/badge/Inspired%20by-ralph--loop-orange.svg)](https://github.com/anthropics/claude-plugins-official/tree/main/plugins/ralph-loop)

> **Vigila al agent. Pilla sus mentiras. No pares hasta que el curro esté hecho de verdad.**

_Un plugin de `Claude Code` que mete al agent en un bucle consigo mismo dentro de una misma sesión y no le deja largarse hasta que la tarea deje de producir ediciones de archivos de verdad — sin "banderita de completado", sin ningún hueco por donde el agent pueda escaquearse._

[Inicio rápido](#inicio-rápido) • [¿Por qué Watchdog?](#por-qué-watchdog) • [Cómo funciona](#cómo-funciona) • [Comandos](#comandos) • [Instalación](#instalación) • [Inspirado en](#inspirado-en)

---

## Mantenedor principal

| Rol | Nombre | GitHub |
| --- | --- | --- |
| Creador y mantenedor | Jonyan Dunh | [@JonyanDunh](https://github.com/JonyanDunh) |

---

## Inicio rápido

**Paso 1: Instalar**

```bash
/plugin marketplace add https://github.com/JonyanDunh/claude-code-watchdog
/plugin install watchdog
/reload-plugins
```

**Paso 2: Verificar**

```bash
/watchdog:help
```

**Paso 3: Lanzar un watchdog**

```bash
/watchdog:start "Arregla los tests de auth inestables en tests/auth/*.ts. Sigue iterando hasta que pase toda la suite." --max-iterations 20
```

Y ya está. Watchdog vuelve a inyectar tu prompt después de cada turno hasta que Claude:

- termina un turno sin modificar ningún archivo, **o**
- llega al límite de seguridad de `--max-iterations`, **o**
- tú ejecutas `/watchdog:stop` a mano.

Todo lo demás es automático. El agent nunca se entera de que hay un bucle corriendo.

---

## ¿Por qué Watchdog?

- **Cero trampas del agent** — Al agent nunca se le dice que está dentro de un bucle. Sin `systemMessage`, sin contador de iteraciones, sin banner de arranque. No puede atajar emitiendo una señal de completado falsa.
- **Verificación con herramientas obligatoria** — Un turno de puro texto ("Lo he revisado, todo bien") jamás termina el bucle. El agent **tiene que** invocar una herramienta de verdad antes de que siquiera se plantee la salida.
- **Detección de cambios de archivos juzgada por un LLM y consciente del proyecto** — En cada disparo del hook, watchdog lanza un **subproceso de Claude Code** de vida corta (`claude -p --model haiku`) y le hace una única pregunta: "¿este turno modificó algún archivo del proyecto?". El subproceso ve la entrada completa de cada invocación de herramienta y decide semánticamente. Haiku es el modelo — lo importante es que se trata de un **proceso de Claude Code aislado y sin estado**, no de un cliente API a medida, así que tu autenticación de `claude` actual se reutiliza tal cual.
- **Aislamiento por sesión** — El archivo de estado se indexa por el ID del proceso padre de Claude Code, descubierto recorriendo la ascendencia de procesos. 100 watchdogs concurrentes en el mismo directorio de proyecto nunca chocan.
- **Oculto por diseño** — Toda la salida de diagnóstico va a stderr. El transcript JSONL nunca filtra metadatos del bucle al contexto del agent.
- **Apache 2.0** — Derivado de forma limpia del propio plugin `ralph-loop` de Anthropic, con la atribución completa en [NOTICE](./NOTICE).

---

## Cómo funciona

Tú ejecutas el comando **una sola vez** y Claude Code se encarga del resto:

```bash
# Lo ejecutas UNA vez:
/watchdog:start "Descripción de tu tarea" --max-iterations 20

# Después Claude Code automáticamente:
# 1. Trabaja en la tarea
# 2. Intenta salir
# 3. El Stop hook bloquea la salida y vuelve a inyectar el MISMO prompt
# 4. Claude itera sobre la misma tarea viendo sus propias ediciones anteriores
# 5. Repite hasta que un turno termina sin modificar ningún archivo del proyecto
#    (o se alcanza --max-iterations)
```

El bucle ocurre **dentro de tu sesión actual** — sin `while true` externo, sin proceso orquestador. El `Stop hook` en `hooks/stop-hook.js` bloquea la salida normal de la sesión y vuelve a inyectar el prompt como un nuevo turno de usuario usando el protocolo nativo de Claude Code: `{"decision": "block", "reason": ...}`.

Esto crea un **bucle de retroalimentación autorreferente** donde:
- El prompt no cambia entre iteraciones
- El trabajo previo de Claude persiste en los archivos
- Cada iteración ve archivos modificados e historial de git
- Claude mejora de forma autónoma leyendo su propio trabajo anterior

### Condiciones de salida

El bucle sale cuando **ambas** cosas son ciertas para el último turno del asistente:

| Comprobación | Requisito |
| --- | --- |
| **Precondición de uso de herramientas** | El turno tiene que haber invocado al menos una herramienta. Los turnos de puro texto nunca salen. |
| **Veredicto del subproceso clasificador** | Un subproceso de Claude Code de vida corta (`claude -p --model haiku`) devuelve `NO_FILE_CHANGES`. El subproceso lee la entrada completa de cada invocación de herramienta y decide semánticamente si el turno modificó directamente algún archivo del proyecto. |

Si alguna de las dos falla, el bucle continúa. Rutas de salida adicionales:

- Se alcanza `--max-iterations` (tope duro, siempre se respeta)
- El usuario ejecuta `/watchdog:stop` (elimina el archivo de estado)
- El archivo de estado se elimina manualmente del disco

---

## Comandos

| Comando | Efecto | Ejemplo |
| --- | --- | --- |
| `/watchdog:start <PROMPT> [--max-iterations N]` | Lanza un watchdog en la sesión actual | `/watchdog:start "Refactoriza services/cache.ts. Itera hasta que pase pnpm test:cache." --max-iterations 20` |
| `/watchdog:stop` | Cancela el watchdog de la sesión actual | `/watchdog:stop` |
| `/watchdog:help` | Imprime la referencia completa dentro de Claude Code | `/watchdog:help` |

### Prompts largos desde un archivo

Si tu prompt contiene saltos de línea, comillas, backticks, `$` u otros caracteres que romperían el análisis de argumentos del shell dentro del bloque `!` del slash command — por ejemplo una especificación de tarea en Markdown con varios párrafos — pásalo como un archivo:

```bash
/watchdog:start --prompt-file ./tmp/my-task.md --max-iterations 20
```

El archivo lo lee Node directamente con `fs.readFileSync`, sin pasar por el escape del shell. Las rutas relativas se resuelven respecto al directorio de trabajo actual de la sesión de Claude Code. El BOM UTF-8 se elimina automáticamente (los archivos del Bloc de notas de Windows son seguros), el contenido CRLF se conserva byte a byte, y los espacios al inicio/final se recortan. **No se puede combinar con un `<PROMPT>` inline** — elige uno u otro.

Funciona con rutas POSIX en Linux/macOS/WSL (`/home/tu/…`, `./tmp/…`), rutas absolutas de Windows (`C:\Users\tu\…`, `C:/Users/tu/…`) y rutas UNC (`\\server\share\…`). El `~` lo expande tu shell (bash/zsh), no Watchdog — en `cmd.exe` usa `%USERPROFILE%\…` o una ruta absoluta. Las rutas con espacios deben ir entre comillas como cualquier otro argumento del shell: `--prompt-file "./my prompts/task.md"`. Para la referencia completa del manejo de rutas, consulta `/watchdog:help`.

### Convergencia más estricta con `--exit-confirmations`

Por defecto, el bucle sale en cuanto el clasificador Haiku devuelve su primer veredicto `NO_FILE_CHANGES`. Para trabajos críticos donde quieres una confirmación con cinturón y tirantes de que el agente realmente convergió, sube el listón:

```bash
/watchdog:start "Refactoriza services/cache.ts. Itera hasta que pnpm test:cache pase." --exit-confirmations 3 --max-iterations 20
```

El bucle ahora requerirá **tres turnos consecutivos** limpios antes de salir. El contador del streak se reinicia a `0` en el momento en que el clasificador devuelve cualquier cosa que no sea `NO_FILE_CHANGES` — incluyendo `FILE_CHANGES`, `AMBIGUOUS`, fallos del clasificador (`CLI_MISSING` / `CLI_FAILED`), o un turno solo de texto (sin invocaciones de herramientas). La convergencia tiene que ser **ininterrumpida** para contar.

El valor por defecto es `1`, idéntico al comportamiento anterior a 1.3.0. Mutuamente excluyente con `--no-classifier`.

### Hot-reload del prompt en mitad del bucle con `--watch-prompt-file`

Si iniciaste el bucle con `--prompt-file` y quieres refinar la tarea mientras corre, añade `--watch-prompt-file`:

```bash
/watchdog:start --prompt-file ./tmp/task.md --watch-prompt-file --max-iterations 30
```

El Stop hook ahora vuelve a leer el archivo del prompt al inicio de cada iteración. Si el contenido ha cambiado desde el turno anterior, la nueva versión se convierte en el siguiente user turn **y** el contador de streak de `--exit-confirmations` se reinicia a `0` (una tarea redefinida no debería heredar la convergencia de la tarea antigua).

El hot-reload **nunca rompe el bucle**: si el archivo está ausente, vacío, o no se puede leer cuando el hook se dispara, el prompt cacheado se mantiene silenciosamente y el bucle continúa. Puedes editar, renombrar, o mover temporalmente el archivo en mitad del bucle sin romper nada — la siguiente iteración recogerá lo que el archivo tenga en ese momento.

Requiere `--prompt-file`. Pasar `--watch-prompt-file` solo es un error.

### Desactivar el clasificador por completo con `--no-classifier`

Para ejecuciones estilo ralph-loop donde no quieres ningún LLM juzgando la convergencia — pararás el bucle manualmente o vía `--max-iterations`:

```bash
/watchdog:start "Sigue iterando hasta que yo /watchdog:stop." --no-classifier
```

El Stop hook salta la llamada a Haiku por completo. Las únicas formas de salir se vuelven `--max-iterations` y `/watchdog:stop`. **`--max-iterations` es opcional** — si lo omites (como en el ejemplo de arriba), el bucle es verdaderamente ilimitado y solo para cuando tú lo dices. **Ya no necesitas pasar `--max-iterations 0`** para significar "ilimitado"; simplemente deja la flag fuera por completo. (La forma con `0` sigue siendo aceptada por compatibilidad.)

El CLI `claude` ni siquiera es necesario en este modo (el subproceso de Haiku nunca se lanza). Compatible con `--prompt-file` y `--watch-prompt-file`. Mutuamente excluyente con `--exit-confirmations` — el contador del streak no tiene sentido cuando no hay un clasificador devolviendo veredictos.

---

## Archivo de estado

El estado por sesión vive en `.claude/watchdog.claudepid.<PID>.local.json`, donde `<PID>` es el ID del proceso padre de Claude Code descubierto recorriendo la ascendencia de procesos. Ejemplo:

```json
{
  "active": true,
  "iteration": 3,
  "max_iterations": 20,
  "claude_pid": 1119548,
  "started_at": "2026-04-11T12:00:00Z",
  "prompt": "Fix the flaky auth tests..."
}
```

Cada sesión de Claude Code tiene un PID distinto, así que **100 watchdogs concurrentes en el mismo directorio de proyecto nunca chocan** — cada uno tiene su propio archivo de estado, y `/watchdog:stop` en cualquiera de ellos solo cancela el bucle de esa sesión concreta.

**Monitorizar los watchdogs activos:**

```bash
# Lista todos los archivos de estado por sesión activos en este proyecto
ls .claude/watchdog.claudepid.*.local.json

# Inspecciona uno con jq o node
node -e "console.log(JSON.parse(require('fs').readFileSync('.claude/watchdog.claudepid.<PID>.local.json','utf8')))"
```

**Matar manualmente todo lo que haya en este proyecto:**

```bash
rm -f .claude/watchdog.claudepid.*.local.json
```

---

## Instalación

### Principal: instalación vía marketplace (recomendada)

```bash
/plugin marketplace add https://github.com/JonyanDunh/claude-code-watchdog
/plugin install watchdog
/reload-plugins
```

Verifica con `/watchdog:help`.

### Alternativa: carga local para una sola sesión

Para probar Watchdog sin tocar tu configuración global, cárgalo solo para una sesión:

```bash
claude --plugin-dir /ruta/absoluta/a/claude-code-watchdog
```

### Alternativa: instalación manual vía `settings.json`

Para CI/CD, despliegues corporativos o uso offline, clona el repo y conéctalo a mano en `~/.claude/settings.json`:

```json
{
  "extraKnownMarketplaces": {
    "claude-code-watchdog": {
      "source": {
        "source": "directory",
        "path": "/ruta/absoluta/a/claude-code-watchdog"
      }
    }
  },
  "enabledPlugins": {
    "watchdog@claude-code-watchdog": true
  }
}
```

Luego ejecuta `/reload-plugins` dentro de Claude Code.

---

## Ocultar el bucle al agent

Por diseño, **el agent no debe saber que está dentro de un bucle**. Si lo supiera, estaría tentado de atajar declarando completado desde memoria en el primer turno. Watchdog fuerza esto mediante:

- **Ningún `systemMessage`** emitido desde el `Stop hook` — sin contador de iteraciones, sin banner de estado.
- **El script de setup solo escribe el prompt del usuario a stdout** — sin cabecera "Loop activated, iteration 1", sin ninguna salida de inicialización que el agent pudiera ver.
- **El prompt reinyectado es el texto original + un único recordatorio de verificación**, en inglés claro:

  > Please re-run the verification by actually invoking tools. Do not, without performing any real tool calls, base your answer on prior context and tell me the check is complete.

- **Todos los diagnósticos van a stderr (`>&2`)** — El transcript de Claude Code no los captura como contexto del agent.

Desde el punto de vista del agent, el mismo usuario está haciendo la misma pregunta una y otra vez, añadiendo ocasionalmente "por favor, vuelve a correr las comprobaciones de verdad". No hay ningún `Stop hook` visible, ningún contador de iteraciones, ningún metadato del bucle. El agent no puede hacer trampa con algo cuya existencia desconoce.

---

## Buenas prácticas al escribir prompts

### 1. Criterios de completado claros

Escribe el prompt de forma que "no hacen falta más ediciones" sea una respuesta genuina y verificable.

❌ Mal: "Construye una API de todos y hazla bien."

✅ Bien:

```markdown
Construye una API REST para todos en `src/api/todos.ts`.

Requisitos:
- Todos los endpoints CRUD funcionando
- Validación de entrada implementada
- 80%+ de cobertura de tests en `tests/todos.test.ts`
- Todos los tests pasan con `pnpm test`
```

### 2. Objetivos incrementales y verificables

El bucle sale cuando "no se modifican archivos". Si tu tarea no tiene un estado final verificable, se quedará girando en el vacío.

✅ Bien:

```markdown
Refactoriza `services/cache.ts` para eliminar la implementación LRU antigua.

Pasos:
1. Elimina la clase LRU vieja y sus tests
2. Actualiza todos los llamadores en `src/` para usar la nueva API de cache
3. Ejecuta `pnpm typecheck && pnpm test:cache` después de cada cambio
4. Itera hasta que ambos pasen sin warnings
```

### 3. Estructura auto-correctiva

Dile al agent cómo detectar los fallos y adaptarse.

```markdown
Implementa la feature X usando TDD:
1. Escribe tests que fallen en tests/feature-x.test.ts
2. Escribe el mínimo código para que pasen
3. Ejecuta `pnpm test:feature-x`
4. Si algún test falla, lee el error, arréglalo, vuelve a ejecutar
5. Refactoriza solo después de que todos los tests estén en verde
```

### 4. Define `--max-iterations` para la mayoría de las tareas

El subproceso clasificador no es infalible. Un agent atascado que no para de hacer ediciones sin sentido, o uno que se confunde y deja de editar antes de tiempo, debería caer en un tope duro. `--max-iterations 20` es un valor por defecto razonable para la mayoría del trabajo.

**Pero la flag es opcional**. Si genuinamente quieres un bucle ilimitado (por ejemplo, un bucle de mantenimiento de larga duración que pretendes detener manualmente con `/watchdog:stop`, o una ejecución `--no-classifier` donde la convergencia la juzgas tú, no Haiku), **simplemente omite la flag por completo**. **No** necesitas pasar `--max-iterations 0` — esa forma sigue siendo aceptada por compatibilidad, pero la manera natural de expresar "ilimitado" ahora es dejar la flag fuera.

---

## Cuándo usar Watchdog

**Bueno para:**

- Tareas con criterios de éxito claros y automatizables (tests, lints, typechecks)
- Refinamiento iterativo: arreglar → probar → arreglar → probar
- Implementaciones greenfield de las que te puedes desentender
- Revisión sistemática de código con arreglos

**No tan bueno para:**

- Tareas que requieren juicio humano o decisiones de diseño
- Operaciones de un solo paso (un único comando, una única edición de archivo)
- Cualquier cosa donde "hecho" sea subjetivo
- Debugging en producción que necesita contexto externo

---

## Requisitos

Watchdog necesita **tanto `claude` como `node` en tu `PATH`** — `node` ejecuta el hook y los scripts de setup del plugin, y `claude` es lo que watchdog lanza (`claude -p --model haiku`) para juzgar si cada turno modificó algún archivo del proyecto.

| Requisito | Por qué |
| --- | --- |
| **Claude Code 2.1+** | Usa el sistema de `Stop hook` y el formato de plugin del marketplace |
| **`node`** 18+ en el `PATH` | Runtime de los hooks y scripts de setup del plugin |
| **`claude` CLI** en el `PATH` | Watchdog lanza un subproceso `claude -p --model haiku` de vida corta en cada disparo del hook para clasificar el turno. Tiene que estar autenticado (OAuth o `ANTHROPIC_API_KEY`) — el subproceso reutiliza las credenciales de sesión que ya tienes. |

### Instalar dependencias

Si instalaste Claude Code vía `npm install -g @anthropic-ai/claude-code`, te llevas `claude` y `node` **de paquete** — el install por npm mete `claude` en tu `PATH`, y Node.js es el propio runtime de npm, así que ya lo tienes. No hace falta instalar nada más.

Si instalaste Claude Code por otra vía (binario standalone, Homebrew, instalador de Windows), `claude` ya está en tu `PATH` pero puede que tengas que instalar Node.js 18+ por tu cuenta:

**macOS (Homebrew):**

```bash
brew install node
# claude CLI: mira https://docs.anthropic.com/claude-code
```

**Debian / Ubuntu / WSL2:**

```bash
# Opción 1: paquete de la distro (puede ser anterior a la 18)
sudo apt update && sudo apt install -y nodejs

# Opción 2: NodeSource (LTS actual)
curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
sudo apt install -y nodejs
```

**Fedora / RHEL:**

```bash
sudo dnf install -y nodejs
```

**Arch / Manjaro:**

```bash
sudo pacman -S --needed nodejs
```

**Windows (PowerShell / cmd nativo):**

```powershell
# winget
winget install OpenJS.NodeJS.LTS

# o scoop
scoop install nodejs-lts

# o bájate el instalador desde https://nodejs.org
```

### Soporte de plataformas

| Plataforma | Estado |
| --- | --- |
| Linux (Node 18 / 20 / 22) | ✅ Probado en CI |
| macOS (Node 18 / 20 / 22) | ✅ Probado en CI |
| Windows (Node 18 / 20 / 22) | ✅ Probado en CI |

---

## Estructura del plugin

Este repo es a la vez el marketplace y el plugin — `marketplace.json` apunta a `./`.

```
claude-code-watchdog/
├── .claude-plugin/
│   ├── marketplace.json     # manifiesto del marketplace
│   └── plugin.json          # manifiesto del plugin
├── commands/
│   ├── start.md             # /watchdog:start
│   ├── stop.md              # /watchdog:stop
│   └── help.md              # /watchdog:help
├── hooks/
│   ├── hooks.json           # registra el Stop hook (invoca node)
│   └── stop-hook.js         # la lógica central del bucle
├── scripts/
│   ├── setup-watchdog.js    # crea el archivo de estado
│   └── stop-watchdog.js     # elimina el archivo de estado
├── lib/                     # módulos compartidos (reutilizados por todos los entry points)
│   ├── constants.js         # patrón del path del estado, tokens marcadores, plantillas de prompt
│   ├── log.js               # diagnósticos por stderr
│   ├── stdin.js             # lector síncrono de stdin
│   ├── state.js             # ciclo de vida atómico del archivo de estado
│   ├── transcript.js        # parser JSONL + extracción de herramientas del turno actual
│   ├── judge.js             # subproceso clasificador de Claude Code + parser del veredicto
│   └── claude-pid.js        # recorrido de la ascendencia de procesos
├── test/                    # tests unitarios + de integración con node:test
│   ├── fixtures/            # fixtures JSONL de transcripts
│   ├── transcript.test.js
│   ├── state.test.js
│   ├── judge.test.js
│   ├── claude-pid.test.js
│   ├── setup.test.js
│   ├── stop-watchdog.test.js
│   ├── stop-hook.test.js
│   └── stop-hook-haiku.test.js
├── .github/                 # workflow de CI (matriz node --test, jsonlint, markdownlint) + plantillas de issue/PR
├── .gitattributes           # fuerza los finales de línea LF
├── LICENSE                  # Apache License 2.0
├── NOTICE                   # atribución a ralph-loop
├── README.md                # este archivo
└── README.{zh,ja,ko,es,vi,pt}.md  # traducciones
```

## Inspirado en

Watchdog es un trabajo derivado del plugin [**ralph-loop**](https://github.com/anthropics/claude-plugins-official/tree/main/plugins/ralph-loop) de Anthropic (Apache License 2.0, © Anthropic, PBC). El `ralph-loop` original usaba un protocolo con etiquetas XML `<promise>COMPLETE</promise>` donde el agent declaraba explícitamente haber terminado.

Watchdog mantiene el mecanismo central — un `Stop hook` que vuelve a inyectar el prompt — y cambia estas cosas por encima:

| | Watchdog | ralph-loop |
| --- | --- | --- |
| **Disparador de salida** | Un subproceso de Claude Code de vida corta (`claude -p --model haiku`) es el **único** juez. Lee la entrada completa de cada invocación de herramienta y decide semánticamente si se modificó directamente algún archivo del proyecto. | El agent tiene que emitir una etiqueta XML `<promise>…</promise>` en su texto final. La frase dentro de las etiquetas es configurable vía `--completion-promise "…"` (por ejemplo `COMPLETE`, `DONE`). Un grep en el `Stop hook` busca la cadena exacta. |
| **Precondición de salida** | Hay que haber llamado a herramientas **Y** que el subproceso clasificador diga `NO_FILE_CHANGES` | Basta con que coincida el texto del `<promise>`. El agent puede hacer trampa emitiendo la etiqueta antes de tiempo; la única defensa de ralph-loop es un prompt que le pide al agent que no mienta. |
| **Visibilidad para el agent** | Completamente oculto (sin systemMessage, sin banner, diagnósticos solo por stderr) | Al agent se le informa del bucle y del protocolo del promise |
| **Ámbito del estado** | Un archivo de estado por cada sesión de Claude Code — sin límite de watchdogs concurrentes en el mismo proyecto | Un solo archivo de estado por proyecto — solo UN ralph-loop puede correr por proyecto a la vez |
| **Formato del archivo de estado** | JSON (parseado con `JSON.parse` nativo) | Markdown con frontmatter YAML (parseado con sed/awk/grep) |
| **Runtime** | Node.js 18+ | Bash + jq + POSIX coreutils |
| **Entrada del prompt** | Inline vía `$ARGUMENTS`, **o** `--prompt-file <path>` — lee el archivo directamente con `fs.readFileSync` de Node, **saltándose por completo el análisis de argumentos del shell**. Seguro para Markdown de varios párrafos con saltos de línea, comillas, backticks, `$`, etc. El BOM UTF-8 se elimina automáticamente; CRLF se preserva byte a byte. | Solo inline vía `$ARGUMENTS` en el bloque `!` del shell del slash command. Cualquier `"`, `` ` ``, `$` o salto de línea sin escapar en el prompt rompe el parser de `bash` con `unexpected EOF`. Sin fallback a archivo ni a stdin — las especificaciones de tareas Markdown de varios párrafos deben convertirse primero en una cadena de una sola línea segura para el shell. |
| **Flexibilidad de convergencia** | `--exit-confirmations N` requiere N veredictos `NO_FILE_CHANGES` **consecutivos** antes de salir (por defecto 1). `--no-classifier` salta Haiku por completo para ejecuciones estilo ralph-loop que solo salen vía `--max-iterations` o `/watchdog:stop`. | Un único mecanismo de emisión-de-tag-y-grep `<promise>…</promise>` sin ningún botón de estricteza ajustable — o el agente emite la frase de promesa configurada o no lo hace. |
| **Evolución del prompt** | `--watch-prompt-file` recarga en caliente `--prompt-file` en cada iteración. Puedes editar la spec de la tarea en mitad del bucle y el siguiente turno la recoge (y reinicia el streak de convergencia, porque la tarea cambió). Archivo ausente / vacío / ilegible mantiene silenciosamente el prompt cacheado — el hot-reload nunca rompe el bucle. | El prompt está fijo en el momento de `/ralph-loop "..."` y no se puede cambiar sin cancelar y reiniciar el bucle. |

Ver [`NOTICE`](./NOTICE) para la atribución completa y el listado detallado de modificaciones.

---

## Licencia

Apache License 2.0. Ver [`LICENSE`](./LICENSE) y [`NOTICE`](./NOTICE).

Watchdog es un trabajo derivado de `ralph-loop` (© Anthropic, PBC, Apache 2.0). Este proyecto **no está afiliado ni respaldado por Anthropic**.

---

<div align="center">

**Inspirado en:** [ralph-loop](https://github.com/anthropics/claude-plugins-official/tree/main/plugins/ralph-loop) (Anthropic, PBC)

**Vigila al agent. Pilla sus mentiras. No pares hasta que el curro esté hecho de verdad.**

</div>
