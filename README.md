# n8n-nodes-shipstatic

n8n community node for [ShipStatic](https://shipstatic.com) — deploy static websites, landing pages, and prototypes instantly from n8n workflows.

## Requirements

**Requires n8n 2.0 or newer** (Node.js 20.19+). The node's code compiles as far
back as n8n 1.85, but 2.x is what it is tested against and what n8n Cloud runs.

## Installation

In your n8n instance, go to **Settings > Community Nodes** and install:

```
n8n-nodes-shipstatic
```

Or install manually:

```bash
cd ~/.n8n/custom
npm init -y
npm install n8n-nodes-shipstatic
```

Restart n8n after installing.

## Deploy — Free, No Account Needed

Add a **ShipStatic** node to your workflow. No credentials to configure.

Set Resource to **Deployment**, Operation to **Deploy**, then pick where the
files come from with **Input**:

**Binary Files** (default) — the workflow-native path.

1. Connect binary files from an upstream node (HTTP Request, Google Drive,
   Read/Write Files, Convert to File)
2. Run — you get a live URL on `*.shipstatic.com`

Each input item becomes one file, and a shared leading directory is stripped,
so a `dist/` build deploys as `index.html` rather than `dist/index.html`.

**Text Content** — one file, typed or wired in.

1. Paste or wire your HTML into **File Content**
2. Run — deployed as `index.html` by default (change it with **File Name**)

**Files (JSON)** — a whole site as data.

Give it an array of files:

```json
[
  { "path": "index.html", "content": "<h1>Hello</h1>" },
  { "path": "style.css", "content": "body { margin: 0 }" }
]
```

Content is plain text by default. For genuinely binary files — images, fonts —
add `"encoding": "base64"` to that entry and pass base64 bytes. Paths are used
exactly as written, so this mode never rewrites them.

That is it. Your site is live instantly. No token, no sign-up, no configuration.

Deployments made without credentials are public and expire in 3 days. The output includes a **claim URL** — visit it to keep the site permanently.

Want a private site? Add a **Password** under the Deploy operation's Options (6–128 characters; whitespace significant). Visitors will be prompted to unlock before viewing, including on any custom domains pointing at the deployment.

### Single-page apps just work

Deploying a React, Vue or Svelte build? The node detects it and adds the routing
config the site needs, so `/about` resolves to your app instead of returning
404. It is on by default and does nothing to sites that are not single-page
apps.

Two ways to take control: turn **Single-Page App Routing** off under Options, or
include your own `ship.json` among the deployed files — the node never
overwrites one you shipped yourself.

### Deployments that clean up after themselves

Deploying a preview for every pull request, or a nightly build nobody needs to
keep? Add **TTL** under Options and the deployment expires on its own after
that many seconds — the platform reclaims it, and you are not left pruning.

Two things to know before you reach for it:

- **It needs credentials.** An anonymous deployment already expires on the
  platform's schedule, so a TTL on one is refused rather than quietly ignored.
- **A deployment with a TTL cannot be linked to a custom domain.** A domain is
  a commitment and a deadline is its opposite — deploy without a TTL if the
  site needs one.

### Retries that do not deploy twice

n8n's **Retry On Fail** makes a workflow the most likely thing to retry a deploy
automatically. Set an **Idempotency Key** under Options and a retry replays the
original deployment instead of creating a second one:

```
{{ $execution.id }}
```

Key the *attempt*, never the try — a value stable across retries of one logical
deploy and different for the next. Leave it empty and every run deploys afresh.

## All Operations — Free API Key

For permanent deployments and full control over your sites and domains, add a free API key:

1. Get a free key at [my.shipstatic.com/api-key](https://my.shipstatic.com/api-key)
2. In n8n, go to **Credentials > New Credential > ShipStatic API**
3. Paste it into **Token** and save — n8n verifies the connection automatically

### One credential slot

The field is called **Token** and your API key is what goes in it — one
credential, two names. Paste a `ship-…` key and every operation in this node
works; n8n verifies the connection when you save.

### Listing

Both **List** operations honour n8n's usual controls. **Return All** follows the
API's pagination to the end rather than stopping at the first page, and
**Limit** stops once it has collected that many. The Deployment and Domain
dropdowns page the same way as you scroll them.

### Deployments

| Operation  | Description                                                                                            |
| ---------- | ------------------------------------------------------------------------------------------------------ |
| **Delete** | Delete a deployment and all its files — the response reports the deletion state |
| **Deploy** | Publish files and get a live URL instantly                                                             |
| **Get**    | Get deployment details including URL, status, file count, size, labels, and password protection state |
| **List**   | List all deployments with their URLs, status, labels, and password protection state                   |
| **Set**    | Update labels on a deployment (replaces all existing labels)                                           |

Deleting is asynchronous: the API acknowledges with the deployment and a
`deleting` status, and the site stays served until background cleanup
completes.

### Domains

| Operation    | Description                                                                     |
| ------------ | ------------------------------------------------------------------------------- |
| **Delete**   | Permanently disconnect and delete a custom domain                               |
| **DNS**      | Look up which DNS provider hosts a domain (e.g. Cloudflare, Namecheap)          |
| **Get**      | Get domain details including linked deployment, verification status, and labels |
| **List**     | List all domains with their linked deployment and verification status           |
| **Records**  | Get the DNS records you need to configure at your DNS provider                  |
| **Set**      | Create or update a custom domain — reserve, link, switch deployments, or update labels |
| **Share**    | Get a shareable setup hash so someone else can view the required DNS records    |
| **Validate** | Check if a domain name is valid and available before connecting it              |
| **Verify**   | Queue a DNS check after you configure the records — the domain's status updates once it runs |

### Account

| Operation   | Description                                               |
| ----------- | --------------------------------------------------------- |
| **Whoami**  | Get your account details including email, plan, and usage |

## Example Workflows

### Publish and connect a custom domain

1. **ShipStatic** > Deployment: Deploy (get the deployment ID)
2. **ShipStatic** > Domain: Set (link your domain to the deployment)
3. **ShipStatic** > Domain: Records (get the records to configure)
4. Configure DNS with your provider
5. **ShipStatic** > Domain: Verify (confirm everything is connected)

### Scheduled redeployment

Use an n8n **Schedule Trigger** to redeploy a site on a recurring basis — useful for sites that pull content from external sources.

## Picking Deployments and Domains

Deployment and Domain fields use n8n's **Resource Locator** with two modes:

- **From List** — search-as-you-type through your existing deployments or domains
- **By Hostname** / **By Name** — type the value directly (useful for new domains via Set/Validate, or for piping in dynamic values from previous nodes)

You can also switch any field to **Expression** mode to use values from upstream nodes.

## AI Agent Support

This node works as a tool in n8n's AI Agent workflows (`usableAsTool: true`).
Connect it to an AI agent and let it deploy sites, manage domains, and check
deployment status as part of a conversation.

**Use Files (JSON) for agent deploys.** An agent fills a node's *parameters*;
it has no way to hand over binary items, so Binary Files mode is not reachable
from a tool call. Files (JSON) is — point the **Files** field at the agent and
it can write a whole multi-file site:

```json
[
  { "path": "index.html", "content": "<h1>Hello</h1><link rel=stylesheet href=style.css>" },
  { "path": "style.css", "content": "body { font-family: system-ui }" }
]
```

The field's description tells the model the schema, so a capable agent gets it
right without further prompting. Two things worth knowing:

- **Text is text.** Content is plain by default; models should not base64 the
  HTML. `"encoding": "base64"` is for images and fonts only.
- **Deletes ask first.** Both Delete operations carry a confirm-with-the-user
  instruction in the text the agent reads.

## Upgrading from 0.x

The 1.x node speaks the current ShipStatic platform; 0.x spoke a retired one
and its keyless deploy no longer works at all. Upgrading is worth it, and it
changes four things in saved workflows:

1. **Re-enter your credential.** The field is now a single **Token** slot that
   takes your API key. A credential created for 0.x
   stored its value in an "API Key" field that 1.x does not read — the node
   refuses to deploy rather than silently falling back to an anonymous public
   deployment, so you will see a clear error until you re-enter it.
2. **Re-pick your operations.** Operation identifiers are now the platform's
   own verbs, so the stored ones from 0.x no longer resolve: `remove` →
   `delete`, Deploy's identifier → `upload` (the label is still "Deploy"), and
   Account's → `whoami`. A workflow carrying a retired identifier fails loudly
   rather than doing something unexpected.
3. **Re-select your Deploy input mode.** The Binary File toggle became the
   **Input** selector (Binary Files / Text Content / Files (JSON)). Workflows
   that used the toggle in its OFF position — text content — do not carry over
   and will default to Binary Files.
4. **Keyless deploys changed internally.** They no longer mint a token first.
   Nothing to do; anonymous deploys keep working, and they work again — this is
   the break that made 0.x's headline feature stop functioning.

## Resources

- [ShipStatic Documentation](https://docs.shipstatic.com)
- [ShipStatic Dashboard](https://my.shipstatic.com)
- [Report an Issue](https://github.com/shipstatic/n8n/issues)

## License

MIT
