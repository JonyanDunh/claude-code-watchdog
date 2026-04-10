[English](./README.md) | [中文](./README.zh.md) | [한국어](./README.ko.md) | [日本語](./README.ja.md) | Español | [Tiếng Việt](./README.vi.md) | [Português](./README.pt.md)

# Watchdog

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
[![Claude Code](https://img.shields.io/badge/Claude%20Code-2.1%2B-7C4DFF.svg)](https://docs.anthropic.com/claude-code)
[![Version](https://img.shields.io/badge/version-1.0.0-green.svg)](./.claude-plugin/plugin.json)
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
- **Detección de cambios de archivos juzgada por un LLM y consciente del proyecto** — Una llamada headless a `claude -p --model haiku` es el **único** juez de "¿este turno modificó algún archivo del proyecto?". Ve la entrada completa de cada invocación de herramienta y decide semánticamente.
- **Aislamiento por sesión** — El archivo de estado se indexa por `TERM_SESSION_ID`, así que lanzar varios watchdogs en distintas pestañas de terminal nunca choca.
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

El bucle ocurre **dentro de tu sesión actual** — sin `while true` externo, sin proceso orquestador. El `Stop hook` en `hooks/stop-hook.sh` bloquea la salida normal de la sesión y vuelve a inyectar el prompt como un nuevo turno de usuario usando el protocolo nativo de Claude Code: `{"decision": "block", "reason": ...}`.

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
| **Veredicto del clasificador Haiku** | Una llamada headless a `claude -p --model haiku` devuelve `NO_FILE_CHANGES`. El clasificador lee la entrada completa de cada invocación de herramienta y decide semánticamente si el turno modificó directamente algún archivo del proyecto. |

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

---

## Archivo de estado

El estado por sesión vive en `.claude/watchdog.<TERM_SESSION_ID>.local.json`:

```json
{
  "active": true,
  "iteration": 3,
  "max_iterations": 20,
  "term_session_id": "c387e44a-afcd-4c0d-95da-5dc7cd2d8b22",
  "started_at": "2026-04-10T12:00:00Z",
  "prompt": "Fix the flaky auth tests..."
}
```

Cada sesión tiene su propio archivo, indexado por `TERM_SESSION_ID`. Lanzar varios watchdogs en distintas pestañas de terminal funciona sin conflictos.

**Monitorizar los watchdogs activos:**

```bash
# Lista todos los archivos de estado por sesión activos en este proyecto
ls .claude/watchdog.*.local.json

# Iteración actual de una sesión concreta
jq .iteration .claude/watchdog.<SESSION_ID>.local.json

# Estado completo
jq . .claude/watchdog.<SESSION_ID>.local.json
```

**Matar manualmente todo lo que haya en este proyecto:**

```bash
rm -f .claude/watchdog.*.local.json
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

### 4. Siempre define `--max-iterations`

El clasificador Haiku no es infalible. Un agent atascado que no para de hacer ediciones sin sentido, o uno que se confunde y deja de editar antes de tiempo, debería caer en un tope duro. `--max-iterations 20` es un valor por defecto razonable.

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

Watchdog 1.1.0 es una **reescritura en Node.js**. Nada de bash, nada de jq, nada de POSIX coreutils — solo necesitas `node` y el `claude` CLI. Corre de forma nativa en Linux, macOS y Windows.

| Requisito | Por qué |
| --- | --- |
| **Claude Code 2.1+** | Usa el sistema de `Stop hook` y el formato de plugin del marketplace |
| **`node`** 18+ en el `PATH` | Toda la lógica de los hooks y del setup está escrita en JavaScript. `node:test` (que usa la suite de tests) requiere Node 18+ |
| **`claude` CLI** en el `PATH` | Se usa para la llamada headless de clasificación con Haiku. Tiene que estar autenticado (OAuth o `ANTHROPIC_API_KEY`) |
| Variable de entorno **`TERM_SESSION_ID`** | Indexa el archivo de estado por sesión. La definen la mayoría de emuladores de terminal (iTerm2, WezTerm, terminales modernas de Linux). Workaround si no está definida: `export TERM_SESSION_ID=$(node -e "console.log(require('crypto').randomUUID())")` antes de lanzar `claude`. |

### Instalar dependencias

Si instalaste Claude Code vía `npm install -g @anthropic-ai/claude-code`, ya tienes `node` en el `PATH` y no hace falta instalar nada más. Si no:

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

No hace falta WSL2 ni Git Bash — Watchdog 1.1.0 corre directo en Windows nativo.

### Soporte de plataformas

| Plataforma | Estado |
| --- | --- |
| Linux (Node 18 / 20 / 22) | ✅ Probado en CI |
| macOS (Node 18 / 20 / 22) | ✅ Probado en CI |
| Windows (Node 18 / 20 / 22) | ✅ Probado en CI (PowerShell / cmd nativo, sin WSL2) |
| WSL2 en Windows | ✅ Funciona (es Linux) |

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
│   ├── stdin.js             # lector síncrono de stdin cross-platform
│   ├── state.js             # ciclo de vida atómico del archivo de estado
│   ├── transcript.js        # parser JSONL + extracción de herramientas del turno actual
│   └── judge.js             # subproceso headless de Haiku + parser del veredicto
├── test/                    # tests unitarios + de integración con node:test
│   ├── fixtures/            # fixtures JSONL de transcripts
│   ├── transcript.test.js
│   ├── state.test.js
│   ├── judge.test.js
│   ├── setup.test.js
│   ├── stop-watchdog.test.js
│   └── stop-hook.test.js
├── .github/                 # workflow de CI (matriz node --test, jsonlint, markdownlint) + plantillas de issue/PR
├── .gitattributes           # fuerza los finales de línea LF
├── LICENSE                  # Apache License 2.0
├── NOTICE                   # atribución a ralph-loop
├── README.md                # este archivo
└── README.{zh,ja,ko,es,vi,pt}.md  # traducciones
```

## Tests

Watchdog 1.1.0 viene con 53 tests automatizados usando el runner `node:test` integrado de Node — sin dependencias externas. Lánzalos desde la raíz del repo.

**Node 22+:**

```bash
node --test 'test/*.test.js'
```

**Node 18 / 20** (el soporte de globs se añadió en Node 21, así que o dejas que tu shell expanda el patrón, o listas los archivos a mano):

```bash
node --test test/*.test.js
```

Ejecuta solo un archivo:

```bash
node --test test/transcript.test.js
```

El CI corre la suite completa en `ubuntu-latest`, `macos-latest` y `windows-latest` con Node 18 / 20 / 22 en cada push y pull request.

---

## Inspirado en

Watchdog es un trabajo derivado del plugin [**ralph-loop**](https://github.com/anthropics/claude-plugins-official/tree/main/plugins/ralph-loop) de Anthropic (Apache License 2.0, © Anthropic, PBC). El `ralph-loop` original usaba un protocolo con etiquetas XML `<promise>COMPLETE</promise>` donde el agent declaraba explícitamente haber terminado.

Watchdog mantiene el mecanismo central — un `Stop hook` que vuelve a inyectar el prompt — y cambia estas cosas por encima:

| | Watchdog | ralph-loop |
| --- | --- | --- |
| **Disparador de salida** | El clasificador headless con Haiku es el **único** juez. Lee la entrada completa de cada invocación de herramienta y decide semánticamente si se modificó directamente algún archivo del proyecto. | El agent tiene que emitir una etiqueta XML `<promise>…</promise>` en su texto final. La frase dentro de las etiquetas es configurable vía `--completion-promise "…"` (por ejemplo `COMPLETE`, `DONE`). Un grep en el `Stop hook` busca la cadena exacta. |
| **Precondición de salida** | Hay que haber llamado a herramientas **Y** que Haiku diga `NO_FILE_CHANGES` | Basta con que coincida el texto del `<promise>`. El agent puede hacer trampa emitiendo la etiqueta antes de tiempo; la única defensa de ralph-loop es un prompt que le pide al agent que no mienta. |
| **Visibilidad para el agent** | Completamente oculto (sin systemMessage, sin banner, diagnósticos solo por stderr) | Al agent se le informa del bucle y del protocolo del promise |
| **Ámbito del estado** | Archivo por sesión, indexado por `TERM_SESSION_ID` | Archivo único de estado a nivel de proyecto |
| **Formato del archivo de estado** | JSON (parseado con `JSON.parse` nativo) | Markdown con frontmatter YAML (parseado con sed/awk/grep) |
| **Runtime** | Node.js 18+ — cross-platform (Linux, macOS, Windows nativo) | Bash + jq + POSIX coreutils — solo Unix |

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
