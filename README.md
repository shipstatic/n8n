# n8n-nodes-shipstatic

n8n community node for [ShipStatic](https://shipstatic.com) — free, no account needed. Deploy static websites, landing pages, and prototypes instantly from n8n workflows.

ShipStatic is static hosting without the complexity. No build steps, no framework lock-in — upload your files and get a live URL.

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

## Getting Started

1. Add a **ShipStatic** node to your workflow
2. Set Resource to **Deployment**, Operation to **Upload**
3. Enter the path to the folder with your website files
4. Run — your site is live instantly

No credentials required for deploy. Deployments without an API key are public and expire in 3 days.

### API Key (optional)

For permanent deployments and access to all operations:

1. Get a free key at [my.shipstatic.com/api-key](https://my.shipstatic.com/api-key)
2. In n8n, go to **Credentials > New Credential > ShipStatic API**
3. Paste your API key and save — n8n verifies the connection automatically

## Operations

### Deployments

| Operation | Description |
|-----------|-------------|
| **Upload** | Publish files and get a live URL instantly — no account needed |
| **Get Many** | List all your deployed sites with their URLs, status, and labels |
| **Get** | Get details for a specific deployment including URL, status, and file count |
| **Update** | Update the labels on a deployment for organization and filtering |
| **Delete** | Permanently remove a deployment and all its files |

### Domains

| Operation | Description |
|-----------|-------------|
| **Create or Update** | Connect a custom domain to your site, switch deployments, or update labels |
| **Get Many** | List all your custom domains with their linked sites and verification status |
| **Get** | Get details for a specific domain including its linked site and DNS status |
| **Get DNS Records** | Get the DNS records you need to configure at your DNS provider |
| **Validate** | Check if a domain name is valid and available before connecting it |
| **Verify DNS** | Check if DNS is configured correctly after you set up the records |
| **Delete** | Permanently disconnect and remove a custom domain |

### Account

| Operation | Description |
|-----------|-------------|
| **Get** | Get your account details including email, plan, and usage |

## Example Workflows

### Publish a site (no account needed)

1. Add a **ShipStatic** node — no credential setup required
2. Set Resource to **Deployment**, Operation to **Upload**
3. Enter the path to the folder with your website files
4. Run — you get a live URL on `*.shipstatic.com`

### Publish and connect a custom domain

1. **ShipStatic** > Upload deployment (get the deployment ID)
2. **ShipStatic** > Create or Update domain (link your domain to the deployment)
3. **ShipStatic** > Get DNS Records (get the records to configure)
4. Configure DNS with your provider
5. **ShipStatic** > Verify DNS (confirm everything is connected)

### Scheduled redeployment

Use an n8n **Schedule Trigger** to redeploy a site on a recurring basis — useful for sites that pull content from external sources.

## Dynamic Dropdowns

When selecting a deployment or domain, the node loads your existing resources as a dropdown for quick selection. You can also switch to expression mode to use dynamic values from previous nodes.

## AI Agent Support

This node works as a tool in n8n's AI Agent workflows (`usableAsTool: true`). Connect it to an AI agent and let it deploy sites, manage domains, and check deployment status as part of a conversation.

## Resources

- [ShipStatic Documentation](https://docs.shipstatic.com)
- [ShipStatic Dashboard](https://my.shipstatic.com)
- [Report an Issue](https://github.com/shipstatic/node/issues)

## License

MIT
