# n8n-nodes-shipstatic

n8n community node for [ShipStatic](https://shipstatic.com) — deploy static websites, landing pages, and prototypes instantly from n8n workflows.

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

**From binary files** (Binary File toggle ON — default):

1. Set Resource to **Deployment**, Operation to **Deploy**
2. Connect binary files from an upstream node (e.g. HTTP Request, Google Drive, Convert to File)
3. Run — you get a live URL on `*.shipstatic.com`

**From text content** (Binary File toggle OFF):

1. Set Resource to **Deployment**, Operation to **Deploy**, toggle **Binary File** off
2. Paste or wire your HTML into **File Content**
3. Run — deployed as `index.html` by default (customizable via **File Name**)

That's it. Your site is live instantly. No token, no sign-up, no configuration.

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

The **Token** field takes either kind of ShipStatic credential, and the server
tells them apart by their shape — there is nothing to select:

| Value | What it can do |
| ----- | -------------- |
| `ship-…` **API key** | Every operation in this node |
| `deploy-…` **deploy token** | Deploy only — it is deploy-scoped by design |

A deploy token will **fail the credential connection test**, which checks
account access. That is expected rather than a broken credential: use one for
deploy-only workflows, and an API key for everything else.

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

| Operation | Description                                               |
| --------- | --------------------------------------------------------- |
| **Get**   | Get your account details including email, plan, and usage |

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

This node works as a tool in n8n's AI Agent workflows (`usableAsTool: true`). Connect it to an AI agent and let it deploy sites, manage domains, and check deployment status as part of a conversation.

## Resources

- [ShipStatic Documentation](https://docs.shipstatic.com)
- [ShipStatic Dashboard](https://my.shipstatic.com)
- [Report an Issue](https://github.com/shipstatic/n8n/issues)

## License

MIT
