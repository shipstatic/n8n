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

1. Set Resource to **Deployment**, Operation to **Deploy**
2. Connect binary files from an upstream node (e.g. Read Binary Files, HTTP Request)
3. Run — you get a live, shareable URL on `*.shipstatic.com`

That's it. Your site is live instantly. No sign-up, no API key, no configuration.

Deployments without an API key are public and expire in 3 days.

## All Operations — Free API Key

For permanent deployments and full control over your sites and domains, add a free API key:

1. Get a free key at [my.shipstatic.com/api-key](https://my.shipstatic.com/api-key)
2. In n8n, go to **Credentials > New Credential > ShipStatic API**
3. Paste your API key and save — n8n verifies the connection automatically

### Deployments

| Operation  | Description                                                                |
| ---------- | -------------------------------------------------------------------------- |
| **Deploy** | Publish files and get a live URL instantly                                 |
| **Get**    | Get deployment details including URL, status, file count, size, and labels |
| **List**   | List all deployments with their URLs, status, and labels                   |
| **Remove** | Permanently remove a deployment and all its files                          |
| **Set**    | Update the labels on a deployment for organization and filtering           |

### Domains

| Operation    | Description                                                                   |
| ------------ | ----------------------------------------------------------------------------- |
| **Get**      | Get domain details including linked deployment, verification status, and labels |
| **List**     | List all domains with their linked deployments and verification status         |
| **Records**  | Get the DNS records you need to configure at your DNS provider                |
| **Remove**   | Permanently disconnect and remove a custom domain                             |
| **Set**      | Connect a custom domain to your site, switch deployments, or update labels    |
| **Validate** | Check if a domain name is valid and available before connecting it            |
| **Verify**   | Check if DNS is configured correctly after you set up the records             |

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

## Dynamic Dropdowns

When selecting a deployment or domain, the node loads your existing resources as a dropdown for quick selection. You can also switch to expression mode to use dynamic values from previous nodes.

## AI Agent Support

This node works as a tool in n8n's AI Agent workflows (`usableAsTool: true`). Connect it to an AI agent and let it deploy sites, manage domains, and check deployment status as part of a conversation.

## Resources

- [ShipStatic Documentation](https://docs.shipstatic.com)
- [ShipStatic Dashboard](https://my.shipstatic.com)
- [Report an Issue](https://github.com/shipstatic/n8n/issues)

## License

MIT
