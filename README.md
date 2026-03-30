# 🚀 NDD Recovery & Mail Automation - v1.0.0

O **NDD Recovery** é uma aplicação desktop de altíssima performance desenvolvida com Tauri v2 (Rust) e React. Projetada para automatizar a auditoria, triagem e notificação de clientes corporativos com equipamentos de impressão offline no portal NDD Print.

A plataforma unifica extração de dados via SOAP, processamento inteligente de regras de negócio e integra-se à Inteligência Artificial para reativar o faturamento de equipamentos sem comunicação.

---

## 🌟 Destaques da Versão 1.0 (Lançamento Oficial)

- **Cérebro Analítico Offline-First:** O sistema salva uma réplica dos contatos e perfis em um banco SQLite local (`ndd_contacts.db`). A inicialização é instantânea e os dados de contato permanecem seguros na máquina do usuário.
- **Integração IA (Google Gemini):** Um motor inteligente em Rust solicita à API do Gemini a redação de e-mails dinâmicos, humanos e contextuais, adaptando o texto se a falha for no Servidor (Host) ou em Equipamentos Isolados.
- **Motor de Disparo Integrado:** E-mails são disparados nativamente via SMTP do Gmail pelo backend em Rust, embutindo assinaturas corporativas HTML e a logo da empresa invisivelmente (CID Inline).
- **Auto-Updater Inteligente:** Sistema nativo de atualização OTA (Over-The-Air) silenciosa atrelada ao GitHub Releases. A aplicação detecta versões novas, faz o download em background e reinicia automaticamente.

---

## 🚀 Funcionalidades Principais

### 📈 Auditoria e Filtro Inteligente
- **Limpeza de Ruído:** O algoritmo remove sumariamente equipamentos com contadores desabilitados, fabricantes não homologados e máquinas com data de leitura corrompida (ex: 2001).
- **Correlação de Falhas:** O sistema analisa a quantidade de equipamentos offline no *mesmo dia* para determinar matematicamente se o problema é geral (Host) ou isolado.

### 📡 Sincronização Assíncrona (SOAP)
- Conecta-se à API da NDD extraindo dados de milhares de impressoras simultaneamente utilizando `tokio` (multithreading e semáforos), reduzindo drasticamente o tempo de extração e evitando gargalos de rede.

### 🏢 Gestão Híbrida de Contatos
- Permite a importação de planilhas Excel (via `calamine`) para popular a base local de clientes, cruzando ativamente os dados extraídos do NDD com os e-mails salvos no SQLite local.

---

## ⚡ Performance e Arquitetura

- **Backend em Rust (Tauri v2):** Consultas SOAP assíncronas e processamento pesado delegados ao core do sistema operacional.
- **Gestão de Concorrência:** Uso de `Arc` e `Mutex` no Rust para gerenciar a injeção de dados em memória enquanto múltiplas threads disparam requisições para a API.
- **Animações Fluidas:** Frontend utilizando `Framer Motion` para transições de estado, loaders de progresso e micro-interações responsivas sem travar a thread principal.

---

## 🧰 Tecnologias Utilizadas

**Frontend (Interface)**
- **React 18 + TypeScript:** Interface reativa, modular e fortemente tipada.
- **Vite:** Build tool ultrarrápido.
- **Tailwind CSS:** Estilização utilitária com design system em tons de Slate, Blue e Indigo.
- **Framer Motion:** Biblioteca de animações complexas para UI.

**Backend (Desktop Core)**
- **Tauri v2:** Framework para aplicações desktop leves e seguras.
- **Rust:** Gerenciamento de memória, threads e concorrência segura.
- **Rusqlite:** Motor local de banco de dados SQLite.
- **Tokio:** Runtime assíncrono para operações de I/O não bloqueantes (SOAP e SMTP).
- **Lettre:** Biblioteca avançada para construção e disparo de e-mails via SMTP.

---

## 📦 Estrutura do Projeto

```plaintext
ndd-recovery-noc/
├── src/
│   ├── App.tsx            # Cérebro da UI, Lógica de Telas, Integração Gemini
│   ├── App.css            # Estilização global e paleta de cores
│   └── assets/            # Ícones e recursos estáticos
├── src-tauri/
│   ├── src/
│   │   ├── main.rs        # Core: Comandos Tauri, SMTP, SOAP, Motor SQLite
│   │   └── canon_logo.png # Imagem injetada como CID nos e-mails
│   ├── Cargo.toml         # Dependências Rust (lettre, reqwest, rusqlite)
│   └── tauri.conf.json    # Configurações do Tauri v2, updater e permissões
└── package.json           # Dependências NPM

🧪 Como Instalar e Rodar
Pré-requisitos
Node.js (v18+)

Rust (Latest Stable)

Visual Studio C++ Build Tools (para compilação no Windows com pacote "Desktop development with C++")

1. Clonar o repositório
Bash
git clone [https://github.com/danielcunhagit/ndd-recovery-noc.git](https://github.com/danielcunhagit/ndd-recovery-noc.git)
cd ndd-recovery-noc
2. Instalar dependências do Frontend
Bash
npm install
3. Executar em Modo de Desenvolvimento
Inicia o servidor Vite e compila o binário Rust (na primeira vez, o Cargo fará o download dos pacotes).

Bash
npm run tauri dev
4. Build de Produção
Gera o instalador .exe e os binários otimizados. Requer configuração de chaves do Updater no terminal antes da execução.

Bash
$env:TAURI_PRIVATE_KEY="sua_chave_privada_aqui"
$env:TAURI_KEY_PASSWORD="sua_senha_se_houver"
npm run tauri build
🔒 Licença
Este software possui integração com ferramentas proprietárias e é de uso interno restrito para automação de processos.