[English](./README.md) | [中文](./README.zh.md) | [한국어](./README.ko.md) | [日本語](./README.ja.md) | [Español](./README.es.md) | [Tiếng Việt](./README.vi.md) | Português

# Watchdog

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
[![Claude Code](https://img.shields.io/badge/Claude%20Code-2.1%2B-7C4DFF.svg)](https://docs.anthropic.com/claude-code)
[![Version](https://img.shields.io/badge/version-1.0.0-green.svg)](./.claude-plugin/plugin.json)
[![GitHub stars](https://img.shields.io/github/stars/JonyanDunh/claude-code-watchdog?style=flat&color=yellow)](https://github.com/JonyanDunh/claude-code-watchdog/stargazers)
[![Inspired by ralph-loop](https://img.shields.io/badge/Inspired%20by-ralph--loop-orange.svg)](https://github.com/anthropics/claude-plugins-official/tree/main/plugins/ralph-loop)

> **Fica de olho no agente. Não engole a lábia. Só larga quando a parada estiver feita de verdade.**

_Um plugin para o `Claude Code` que prende o agente num loop auto-referencial dentro da mesma sessão e se recusa a deixar ele sair enquanto a tarefa ainda estiver gerando edições de arquivo — sem "flag de conclusão", sem brecha pro agente dar um jeitinho e escapar._

[Início rápido](#início-rápido) • [Por que usar o Watchdog?](#por-que-usar-o-watchdog) • [Como funciona](#como-funciona) • [Comandos](#comandos) • [Instalação](#instalação) • [Inspiração](#inspiração)

---

## Mantenedor principal

| Papel | Nome | GitHub |
| --- | --- | --- |
| Criador e mantenedor | Jonyan Dunh | [@JonyanDunh](https://github.com/JonyanDunh) |

---

## Início rápido

**Passo 1: Instalar**

```bash
/plugin marketplace add https://github.com/JonyanDunh/claude-code-watchdog
/plugin install watchdog
/reload-plugins
```

**Passo 2: Verificar**

```bash
/watchdog:help
```

**Passo 3: Iniciar um watchdog**

```bash
/watchdog:start "Fix the flaky auth tests in tests/auth/*.ts. Keep iterating until the whole suite passes." --max-iterations 20
```

Pronto. Depois de cada turno, o Watchdog reinjeta seu prompt até o Claude:

- terminar um turno sem modificar nenhum arquivo, **ou**
- bater no limite de segurança do `--max-iterations`, **ou**
- você rodar `/watchdog:stop` na mão.

O resto é tudo automático. O agente nunca fica sabendo que tem um loop rolando.

---

## Por que usar o Watchdog?

- **Zero trapaça do agente** — O agente nunca é avisado de que está num loop. Nada de `systemMessage`, nada de contador de iterações, nada de banner de inicialização. Ele não consegue dar um curto-circuito soltando um sinal de conclusão falso.
- **Verificação obrigatória via ferramentas** — Um turno só com texto ("verifiquei, tá tudo certo") nunca encerra o loop. O agente **tem** que chamar uma ferramenta de verdade pra nem ser considerado apto a sair.
- **Detecção de mudanças feita por LLM, consciente do projeto** — Uma chamada headless `claude -p --model haiku` é a **única** responsável por julgar "esse turno modificou algum arquivo do projeto?". Ela enxerga o input completo de cada invocação de ferramenta e decide semanticamente.
- **Isolamento por sessão** — O arquivo de estado é chaveado por `TERM_SESSION_ID`, então rodar vários watchdogs em abas de terminal diferentes nunca dá conflito.
- **Escondido por design** — Toda a saída de diagnóstico vai pro stderr. O transcript JSONL nunca vaza metadados do loop pro contexto do agente.
- **Apache 2.0** — Derivado de forma limpa do plugin `ralph-loop` da própria Anthropic, com a atribuição completa no [NOTICE](./NOTICE).

---

## Como funciona

Você roda o comando **uma vez** e o `Claude Code` cuida do resto:

```bash
# Você roda UMA vez:
/watchdog:start "Your task description" --max-iterations 20

# Daí o Claude Code automaticamente:
# 1. Trabalha na tarefa
# 2. Tenta sair
# 3. O Stop hook bloqueia a saída e reinjeta o MESMO prompt
# 4. O Claude continua iterando na mesma tarefa, vendo suas próprias edições anteriores
# 5. Repete até um turno terminar sem modificar nenhum arquivo do projeto
#    (ou até bater em --max-iterations)
```

O loop acontece **dentro da sua sessão atual** — nada de `while true` externo, nada de processo orquestrador. O Stop hook em `hooks/stop-hook.sh` bloqueia a saída normal da sessão e reinjeta o prompt como um novo turno de usuário usando o protocolo nativo do `Claude Code`: `{"decision": "block", "reason": ...}`.

Isso monta um **loop de feedback auto-referencial** onde:
- O prompt nunca muda entre iterações
- O trabalho anterior do Claude permanece nos arquivos
- Cada iteração vê os arquivos modificados e o histórico do git
- O Claude melhora sozinho lendo o próprio trabalho anterior

### Condições de saída

O loop encerra quando **as duas** condições abaixo são verdadeiras no último turno do assistente:

| Verificação | Requisito |
| --- | --- |
| **Pré-condição de uso de ferramenta** | O turno precisa ter invocado pelo menos uma ferramenta. Turnos só com texto nunca encerram o loop. |
| **Veredicto do classificador Haiku** | Uma chamada headless `claude -p --model haiku` retorna `NO_FILE_CHANGES`. O classificador lê o input completo de cada invocação de ferramenta e decide semanticamente se o turno modificou diretamente algum arquivo do projeto. |

Se qualquer uma das duas falhar, o loop continua. Outras formas de sair:

- `--max-iterations` atingido (limite rígido, sempre respeitado)
- Usuário roda `/watchdog:stop` (remove o arquivo de estado)
- Arquivo de estado removido manualmente do disco

---

## Comandos

| Comando | Efeito | Exemplo |
| --- | --- | --- |
| `/watchdog:start <PROMPT> [--max-iterations N]` | Inicia um watchdog na sessão atual | `/watchdog:start "Refactor services/cache.ts. Iterate until pnpm test:cache passes." --max-iterations 20` |
| `/watchdog:stop` | Cancela o watchdog da sessão atual | `/watchdog:stop` |
| `/watchdog:help` | Mostra a referência completa dentro do `Claude Code` | `/watchdog:help` |

---

## Arquivo de estado

O estado por sessão fica em `.claude/watchdog.<TERM_SESSION_ID>.local.json`:

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

Cada sessão tem seu próprio arquivo, chaveado por `TERM_SESSION_ID`. Dá pra rodar vários watchdogs em abas de terminal diferentes sem nenhum conflito.

**Monitorar watchdogs ativos:**

```bash
# Lista todos os arquivos de estado por sessão ativos neste projeto
ls .claude/watchdog.*.local.json

# Iteração atual de uma sessão específica
jq .iteration .claude/watchdog.<SESSION_ID>.local.json

# Estado completo
jq . .claude/watchdog.<SESSION_ID>.local.json
```

**Matar tudo neste projeto na mão:**

```bash
rm -f .claude/watchdog.*.local.json
```

---

## Instalação

### Recomendado: instalação via marketplace

```bash
/plugin marketplace add https://github.com/JonyanDunh/claude-code-watchdog
/plugin install watchdog
/reload-plugins
```

Verifique com `/watchdog:help`.

### Alternativa: carga local por sessão

Pra testar o Watchdog sem mexer na sua config global, carrega ele só pra uma sessão:

```bash
claude --plugin-dir /absolute/path/to/claude-code-watchdog
```

### Alternativa: instalação manual via `settings.json`

Pra CI/CD, ambientes corporativos ou uso offline, clona o repo e configura na mão no `~/.claude/settings.json`:

```json
{
  "extraKnownMarketplaces": {
    "claude-code-watchdog": {
      "source": {
        "source": "directory",
        "path": "/absolute/path/to/claude-code-watchdog"
      }
    }
  },
  "enabledPlugins": {
    "watchdog@claude-code-watchdog": true
  }
}
```

Depois roda `/reload-plugins` dentro do `Claude Code`.

---

## Escondendo o loop do agente

Por design, **o agente não pode saber que está dentro de um loop**. Se soubesse, ia ser tentado a dar um curto-circuito no primeiro turno dizendo "pronto, terminei" só com base na memória. O Watchdog impõe isso assim:

- **Nenhum `systemMessage`** emitido pelo Stop hook — sem contador de iterações, sem banner de status.
- **O script de setup escreve só o prompt do usuário no stdout** — sem cabeçalho "Loop ativado, iteração 1", sem nenhuma saída de inicialização que o agente possa ver.
- **O prompt reinjetado é o texto original + um único lembrete de verificação**, em inglês puro:

  > Please re-run the verification by actually invoking tools. Do not, without performing any real tool calls, base your answer on prior context and tell me the check is complete.

- **Todos os diagnósticos vão pro stderr (`>&2`)** — o transcript do `Claude Code` não captura eles como contexto do agente.

Do ponto de vista do agente, é o mesmo usuário fazendo a mesma pergunta várias vezes, de vez em quando acrescentando um "por favor roda as checagens de verdade". Não tem Stop hook visível, não tem contador de iteração, não tem metadado de loop. O agente não consegue trapacear o que ele nem sabe que existe.

---

## Boas práticas pra escrever o prompt

### 1. Critérios de conclusão claros

Escreva o prompt de forma que "não precisa mais editar nada" seja uma resposta genuína e verificável.

❌ Ruim: "Constrói uma API de todos e deixa ela boa."

✅ Bom:

```markdown
Build a REST API for todos in `src/api/todos.ts`.

Requirements:
- All CRUD endpoints working
- Input validation in place
- 80%+ test coverage in `tests/todos.test.ts`
- All tests pass with `pnpm test`
```

### 2. Objetivos incrementais e verificáveis

O loop sai quando "nenhum arquivo foi modificado". Se sua tarefa não tem um estado final verificável, ela só vai ficar girando.

✅ Bom:

```markdown
Refactor `services/cache.ts` to remove the legacy LRU implementation.

Steps:
1. Delete the old LRU class and its tests
2. Update all callers in `src/` to use the new cache API
3. Run `pnpm typecheck && pnpm test:cache` after each change
4. Iterate until both pass without warnings
```

### 3. Estrutura autocorretiva

Diga pro agente como perceber falhas e se adaptar.

```markdown
Implement feature X using TDD:
1. Write failing tests in tests/feature-x.test.ts
2. Write minimum code to pass
3. Run `pnpm test:feature-x`
4. If any test fails, read the failure, fix, re-run
5. Refactor only after all tests are green
```

### 4. Sempre defina `--max-iterations`

O classificador Haiku não é infalível. Um agente travado que fica fazendo edições sem sentido, ou um que se perde e para de editar cedo demais, precisa cair num limite rígido. `--max-iterations 20` é um default razoável.

---

## Quando usar o Watchdog

**Bom pra:**

- Tarefas com critérios de sucesso claros e automatizados (testes, lints, typechecks)
- Refinamento iterativo: corrige → testa → corrige → testa
- Implementações greenfield das quais você pode se afastar
- Revisão sistemática de código com correções

**Não é bom pra:**

- Tarefas que exigem julgamento humano ou decisões de design
- Operações de um tiro só (um comando único, uma edição única)
- Qualquer coisa em que "pronto" seja subjetivo
- Debug em produção que depende de contexto externo

---

## Requisitos

| Requisito | Por quê |
| --- | --- |
| **`Claude Code` 2.1+** | Usa o sistema de Stop hook e o formato de plugin do marketplace |
| **Variável de ambiente `TERM_SESSION_ID`** | Chave do arquivo de estado por sessão. A maioria dos emuladores de terminal define (iTerm2, WezTerm, Windows Terminal, terminais Linux modernos). Se não estiver setada: `export TERM_SESSION_ID=$(uuidgen)` antes de abrir o `claude`. |
| **`jq`** no `PATH` | Usado pelo Stop hook pra parsear o JSONL do transcript e o JSON do arquivo de estado |
| **CLI `claude`** no `PATH` | Usada na chamada headless de classificação do Haiku. Precisa estar autenticada (OAuth ou `ANTHROPIC_API_KEY`) |

---

## Estrutura do plugin

Este repo é ao mesmo tempo o marketplace e o plugin — o `marketplace.json` aponta pra `./`.

```
claude-code-watchdog/
├── .claude-plugin/
│   ├── marketplace.json     # manifesto do marketplace
│   └── plugin.json          # manifesto do plugin
├── commands/
│   ├── start.md             # /watchdog:start
│   ├── stop.md              # /watchdog:stop
│   └── help.md              # /watchdog:help
├── hooks/
│   ├── hooks.json           # registra o Stop hook
│   └── stop-hook.sh         # a lógica central do loop
├── scripts/
│   ├── setup-watchdog.sh    # cria o arquivo de estado
│   └── stop-watchdog.sh     # remove o arquivo de estado
├── .gitattributes           # força final de linha LF (crítico pra shell scripts)
├── LICENSE                  # Apache License 2.0
├── NOTICE                   # atribuição ao ralph-loop
├── README.md                # este arquivo
└── README.zh.md             # tradução em chinês
```

---

## Inspiração

O Watchdog é uma obra derivada do plugin [**ralph-loop**](https://github.com/anthropics/claude-plugins-official/tree/main/plugins/ralph-loop) da Anthropic (Apache License 2.0, © Anthropic, PBC). O `ralph-loop` original usava um protocolo baseado na tag XML `<promise>COMPLETE</promise>`, onde o agente declarava explicitamente a conclusão.

O Watchdog mantém a mecânica principal — um Stop hook que reinjeta o prompt — e muda as seguintes coisas em cima disso:

| | Watchdog | ralph-loop |
| --- | --- | --- |
| **Gatilho de saída** | O classificador headless Haiku é o **único** juiz. Ele lê o input completo de cada invocação de ferramenta e decide semanticamente se algum arquivo do projeto foi modificado diretamente. | O agente tem que emitir uma tag XML `<promise>…</promise>` no texto final. A frase dentro das tags é configurável via `--completion-promise "…"` (por exemplo `COMPLETE`, `DONE`). Um grep no Stop hook casa a string exata. |
| **Pré-condição de saída** | Ferramentas precisam ter sido chamadas **E** o Haiku precisa dizer `NO_FILE_CHANGES` | Só o match do texto `<promise>`. O agente pode trapacear emitindo a tag antes da hora; a única defesa do `ralph-loop` é um prompt pedindo que o agente não minta. |
| **Visibilidade pro agente** | Totalmente escondido (sem systemMessage, sem banner, diagnósticos só no stderr) | O agente é informado sobre o loop e o protocolo de promise |
| **Escopo do estado** | Arquivo por sessão, chaveado por `TERM_SESSION_ID` | Arquivo único, escopo por projeto |
| **Formato do arquivo de estado** | JSON (parseado com jq) | Markdown com frontmatter YAML (parseado com sed/awk/grep) |

Veja o [`NOTICE`](./NOTICE) pra atribuição completa e a lista total de modificações.

---

## Licença

Apache License 2.0. Veja [`LICENSE`](./LICENSE) e [`NOTICE`](./NOTICE).

O Watchdog é uma obra derivada do `ralph-loop` (© Anthropic, PBC, Apache 2.0). Este projeto **não é afiliado nem endossado pela Anthropic**.

---

<div align="center">

**Inspirado em:** [ralph-loop](https://github.com/anthropics/claude-plugins-official/tree/main/plugins/ralph-loop) (Anthropic, PBC)

**Fica de olho no agente. Não engole a lábia. Só larga quando a parada estiver feita de verdade.**

</div>
