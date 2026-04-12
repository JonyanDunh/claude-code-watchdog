[English](./README.md) | [中文](./README.zh.md) | [한국어](./README.ko.md) | [日本語](./README.ja.md) | [Español](./README.es.md) | [Tiếng Việt](./README.vi.md) | Português

# Watchdog

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
[![Claude Code](https://img.shields.io/badge/Claude%20Code-2.1%2B-7C4DFF.svg)](https://docs.anthropic.com/claude-code)
[![Version](https://img.shields.io/badge/version-1.2.0-green.svg)](./.claude-plugin/plugin.json)
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
- **Detecção de mudanças feita por LLM, consciente do projeto** — A cada disparo do hook, o Watchdog sobe um **subprocesso do Claude Code** curtinho (`claude -p --model haiku`) e faz uma única pergunta pra ele: "esse turno modificou algum arquivo do projeto?". O subprocesso enxerga o input completo de cada invocação de ferramenta e decide semanticamente. O Haiku é só o modelo — o importante é que é um **processo do Claude Code isolado e stateless**, não um cliente de API customizado, então sua autenticação `claude` existente é reaproveitada do jeito que tá.
- **Isolamento por sessão** — O arquivo de estado é chaveado pelo ID do processo pai do Claude Code, descoberto caminhando pela ancestralidade do processo. 100 sessões simultâneas de watchdog no mesmo diretório do projeto nunca dão conflito.
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

O loop acontece **dentro da sua sessão atual** — nada de `while true` externo, nada de processo orquestrador. O Stop hook em `hooks/stop-hook.js` bloqueia a saída normal da sessão e reinjeta o prompt como um novo turno de usuário usando o protocolo nativo do `Claude Code`: `{"decision": "block", "reason": ...}`.

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
| **Veredicto do subprocesso classificador** | Um subprocesso do Claude Code curtinho (`claude -p --model haiku`) retorna `NO_FILE_CHANGES`. O subprocesso lê o input completo de cada invocação de ferramenta e decide semanticamente se o turno modificou diretamente algum arquivo do projeto. |

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

### Prompts longos a partir de um arquivo

Se seu prompt contiver quebras de linha, aspas, crases, `$` ou outros caracteres que quebrariam o parser de argumentos do shell dentro do bloco `!` do slash command — por exemplo uma especificação de tarefa em Markdown com vários parágrafos — passe-o como um arquivo:

```bash
/watchdog:start --prompt-file ./tmp/my-task.md --max-iterations 20
```

O arquivo é lido diretamente pelo Node com `fs.readFileSync`, ignorando totalmente o escape do shell. Caminhos relativos são resolvidos a partir do diretório de trabalho atual da sessão do Claude Code. O BOM UTF-8 é removido automaticamente (arquivos do Bloco de Notas do Windows são seguros), o conteúdo CRLF é preservado byte a byte, e espaços em branco no início/fim são aparados. **Não pode ser combinado com um `<PROMPT>` inline** — escolha um ou outro.

Funciona com caminhos POSIX em Linux/macOS/WSL (`/home/voce/…`, `./tmp/…`), caminhos absolutos do Windows (`C:\Users\voce\…`, `C:/Users/voce/…`) e caminhos UNC (`\\server\share\…`). O `~` é expandido pelo seu shell (bash/zsh), não pelo Watchdog — no `cmd.exe` use `%USERPROFILE%\…` ou um caminho absoluto. Caminhos com espaços precisam ser colocados entre aspas, como qualquer outro argumento de shell: `--prompt-file "./my prompts/task.md"`. Veja `/watchdog:help` para a referência completa de tratamento de caminhos.

### Convergência mais estrita com `--exit-confirmations`

Por padrão, o loop sai assim que o classificador Haiku retorna seu primeiro veredito `NO_FILE_CHANGES`. Para trabalhos de alto risco onde você quer uma confirmação com cinto e suspensórios de que o agente realmente convergiu, eleve o sarrafo:

```bash
/watchdog:start "Refatore services/cache.ts. Itere até pnpm test:cache passar." --exit-confirmations 3 --max-iterations 20
```

O loop agora exigirá **três turnos consecutivos** limpos antes de sair. O contador de streak é resetado para `0` no momento em que o classificador retorna qualquer coisa que não seja `NO_FILE_CHANGES` — incluindo `FILE_CHANGES`, `AMBIGUOUS`, falhas do classificador (`CLI_MISSING` / `CLI_FAILED`), ou um turno apenas de texto (sem invocações de ferramentas). A convergência precisa ser **ininterrupta** para contar.

O padrão é `1`, idêntico ao comportamento anterior à 1.3.0. Mutuamente exclusivo com `--no-classifier`.

### Hot-reload do prompt no meio do loop com `--watch-prompt-file`

Se você iniciou o loop com `--prompt-file` e quer refinar a tarefa enquanto ela roda, adicione `--watch-prompt-file`:

```bash
/watchdog:start --prompt-file ./tmp/task.md --watch-prompt-file --max-iterations 30
```

O Stop hook agora relê o arquivo do prompt no início de cada iteração. Se o conteúdo mudou desde o turno anterior, a nova versão se torna o próximo user turn **e** o contador de streak de `--exit-confirmations` é resetado para `0` (uma tarefa redefinida não deve herdar a convergência da tarefa antiga).

O hot-reload **nunca quebra o loop**: se o arquivo estiver ausente, vazio, ou ilegível quando o hook dispara, o prompt cacheado é mantido silenciosamente e o loop continua. Você pode editar, renomear, ou mover temporariamente o arquivo no meio do loop sem quebrar nada — a próxima iteração pega o que o arquivo tiver naquele momento.

Requer `--prompt-file`. **Passar `--watch-prompt-file` sozinho é um erro**.

### Desativar o classificador completamente com `--no-classifier`

Para execuções estilo ralph-loop onde você não quer nenhum LLM julgando convergência — você vai parar o loop manualmente ou via `--max-iterations`:

```bash
/watchdog:start "Continue iterando até eu /watchdog:stop." --no-classifier
```

O Stop hook pula a chamada ao Haiku completamente. As únicas formas de sair se tornam `--max-iterations` e `/watchdog:stop`. **`--max-iterations` é opcional** — se você omiti-lo (como no exemplo acima), o loop é verdadeiramente ilimitado e só para quando você manda.

O CLI `claude` nem mesmo é necessário neste modo (o subprocesso Haiku nunca é spawned). Compatível com `--prompt-file` e `--watch-prompt-file`. **Mutuamente exclusivo com `--exit-confirmations`** — o contador de streak é sem sentido quando não há classificador retornando vereditos.

---

## Arquivo de estado

O estado por sessão fica em `.claude/watchdog.claudepid.<PID>.local.json`, onde `<PID>` é o ID do processo pai do Claude Code, descoberto caminhando pela ancestralidade do processo. Exemplo:

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

Cada sessão do Claude Code tem um PID distinto, então **100 sessões simultâneas de watchdog no mesmo diretório do projeto nunca dão conflito** — cada uma ganha seu próprio arquivo de estado, e o `/watchdog:stop` em qualquer uma delas só cancela o loop daquela sessão específica.

**Monitorar watchdogs ativos:**

```bash
# Lista todos os arquivos de estado por sessão ativos neste projeto
ls .claude/watchdog.claudepid.*.local.json

# Inspeciona um via jq ou node
node -e "console.log(JSON.parse(require('fs').readFileSync('.claude/watchdog.claudepid.<PID>.local.json','utf8')))"
```

**Matar tudo neste projeto na mão:**

```bash
rm -f .claude/watchdog.claudepid.*.local.json
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

### 4. Defina `--max-iterations` para a maioria das tarefas

O subprocesso classificador não é infalível. Um agente travado que fica fazendo edições sem sentido, ou um que se perde e para de editar cedo demais, precisa cair num limite rígido. `--max-iterations 20` é um default razoável para a maior parte do trabalho.

**Mas a flag é opcional**. Se você genuinamente quer um loop ilimitado (por exemplo, um loop de manutenção de longa duração que você pretende parar manualmente com `/watchdog:stop`, ou uma execução `--no-classifier` onde a convergência é julgada por você, não pelo Haiku), **simplesmente omita a flag por completo**.

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

O Watchdog precisa **tanto do `claude` quanto do `node` no seu `PATH`** — o `node` roda os scripts de hook e setup do plugin, e o `claude` é o que o watchdog sobe (`claude -p --model haiku`) pra julgar se cada turno modificou algum arquivo do projeto.

| Requisito | Por quê |
| --- | --- |
| **`Claude Code` 2.1+** | Usa o sistema de Stop hook e o formato de plugin do marketplace |
| **`node`** 18+ no `PATH` | Runtime dos hooks e scripts de setup do plugin |
| **CLI `claude`** no `PATH` | A cada disparo do hook, o Watchdog sobe um subprocesso `claude -p --model haiku` curtinho pra classificar o turno. Precisa estar autenticada (OAuth ou `ANTHROPIC_API_KEY`) — o subprocesso reaproveita as credenciais da sua sessão existente. |

### Instalar dependências

Se você instalou o `Claude Code` via `npm install -g @anthropic-ai/claude-code`, já ganha **os dois** — `claude` e `node` — no mesmo pacote: o install do npm coloca o `claude` no seu `PATH`, e o Node.js é o runtime do próprio npm, então ele já tá lá. Não precisa instalar mais nada.

Se você instalou o `Claude Code` de outro jeito (binário standalone, Homebrew, instalador do Windows), o `claude` já tá no seu `PATH`, mas pode ser que precise instalar o Node.js 18+ separado:

**macOS (Homebrew):**

```bash
brew install node
# CLI claude: veja https://docs.anthropic.com/claude-code
```

**Debian / Ubuntu / WSL2:**

```bash
# Opção 1: pacote da distro (pode ser mais antigo que 18)
sudo apt update && sudo apt install -y nodejs

# Opção 2: NodeSource (LTS atual)
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

# ou scoop
scoop install nodejs-lts

# ou baixa o instalador em https://nodejs.org
```

### Suporte a plataformas

| Plataforma | Status |
| --- | --- |
| Linux (Node 18 / 20 / 22) | ✅ Testado no CI |
| macOS (Node 18 / 20 / 22) | ✅ Testado no CI |
| Windows (Node 18 / 20 / 22) | ✅ Testado no CI |

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
│   ├── hooks.json           # registra o Stop hook (invoca o node)
│   └── stop-hook.js         # a lógica central do loop
├── scripts/
│   ├── setup-watchdog.js    # cria o arquivo de estado
│   └── stop-watchdog.js     # remove o arquivo de estado
├── lib/                     # módulos compartilhados (reusados por todos os entry points)
│   ├── constants.js         # padrão do path de estado, tokens de marcador, templates de prompt
│   ├── log.js               # diagnósticos pro stderr
│   ├── stdin.js             # leitor sync de stdin
│   ├── state.js             # ciclo de vida atômico do arquivo de estado
│   ├── transcript.js        # parser de JSONL + extração de ferramentas do turno atual
│   ├── judge.js             # subprocesso classificador do Claude Code + parser de veredicto
│   └── claude-pid.js        # caminhada pela ancestralidade do processo
├── test/                    # testes unitários + integração com node:test
│   ├── fixtures/            # fixtures JSONL de transcript
│   ├── transcript.test.js
│   ├── state.test.js
│   ├── judge.test.js
│   ├── claude-pid.test.js
│   ├── setup.test.js
│   ├── stop-watchdog.test.js
│   ├── stop-hook.test.js
│   └── stop-hook-haiku.test.js
├── .github/                 # workflow de CI (matrix node --test, jsonlint, markdownlint) + templates de issue/PR
├── .gitattributes           # força final de linha LF
├── LICENSE                  # Apache License 2.0
├── NOTICE                   # atribuição ao ralph-loop
├── README.md                # este arquivo
└── README.{zh,ja,ko,es,vi,pt}.md  # traduções
```

## Inspiração

O Watchdog é uma obra derivada do plugin [**ralph-loop**](https://github.com/anthropics/claude-plugins-official/tree/main/plugins/ralph-loop) da Anthropic (Apache License 2.0, © Anthropic, PBC). O `ralph-loop` original usava um protocolo baseado na tag XML `<promise>COMPLETE</promise>`, onde o agente declarava explicitamente a conclusão.

O Watchdog mantém a mecânica principal — um Stop hook que reinjeta o prompt — e muda as seguintes coisas em cima disso:

| | Watchdog | ralph-loop |
| --- | --- | --- |
| **Gatilho de saída** | Um subprocesso do Claude Code curtinho (`claude -p --model haiku`) é o **único** juiz. Ele lê o input completo de cada invocação de ferramenta e decide semanticamente se algum arquivo do projeto foi modificado diretamente. | O agente tem que emitir uma tag XML `<promise>…</promise>` no texto final. A frase dentro das tags é configurável via `--completion-promise "…"` (por exemplo `COMPLETE`, `DONE`). Um grep no Stop hook casa a string exata. |
| **Pré-condição de saída** | Ferramentas precisam ter sido chamadas **E** o subprocesso classificador precisa dizer `NO_FILE_CHANGES` | Só o match do texto `<promise>`. O agente pode trapacear emitindo a tag antes da hora; a única defesa do `ralph-loop` é um prompt pedindo que o agente não minta. |
| **Visibilidade pro agente** | Totalmente escondido (sem systemMessage, sem banner, diagnósticos só no stderr) | O agente é informado sobre o loop e o protocolo de promise |
| **Escopo do estado** | Um arquivo de estado por sessão do Claude Code — quantos watchdogs simultâneos quiser no mesmo projeto | Um único arquivo de estado por projeto — só UM ralph-loop roda por projeto de cada vez |
| **Formato do arquivo de estado** | JSON (parseado com `JSON.parse` nativo) | Markdown com frontmatter YAML (parseado com sed/awk/grep) |
| **Runtime** | Node.js 18+ | Bash + jq + POSIX coreutils |
| **Entrada do prompt** | Inline via `$ARGUMENTS`, **ou** `--prompt-file <path>` — lê o arquivo diretamente com `fs.readFileSync` do Node, **ignorando totalmente o parser de argumentos do shell**. Seguro para Markdown de vários parágrafos contendo quebras de linha, aspas, crases, `$`, etc. O BOM UTF-8 é removido automaticamente; CRLF é preservado byte a byte. | Apenas inline via `$ARGUMENTS` no bloco `!` do shell do slash command. Qualquer `"`, `` ` ``, `$` ou quebra de linha sem escape no prompt quebra o parser do `bash` com `unexpected EOF`. Sem fallback para arquivo ou stdin — especificações de tarefa em Markdown com vários parágrafos precisam ser convertidas antes em uma string de uma única linha segura para o shell. |
| **Flexibilidade de convergência** | `--exit-confirmations N` requer N vereditos `NO_FILE_CHANGES` **consecutivos** antes de sair (padrão 1). `--no-classifier` pula o Haiku por completo para execuções estilo ralph-loop que só saem via `--max-iterations` ou `/watchdog:stop`. | Um único mecanismo de emissão-de-tag-e-grep `<promise>…</promise>` sem nenhum botão de estricteza ajustável — ou o agente emite a frase de promessa configurada ou não. |
| **Evolução do prompt** | `--watch-prompt-file` faz hot-reload de `--prompt-file` em cada iteração. Você pode editar a spec da tarefa no meio do loop e o próximo turno a captura (e reseta o streak de convergência, porque a tarefa mudou). Arquivo ausente / vazio / ilegível mantém silenciosamente o prompt cacheado — o hot-reload nunca quebra o loop. | O prompt é fixo no momento de `/ralph-loop "..."` e não pode ser alterado sem cancelar e reiniciar o loop. |

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
