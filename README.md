# n8n-nodes-shipstatic

n8n community node for [ShipStatic](https://shipstatic.com) - publish and manage static sites directly from n8n workflows.

ShipStatic is a simpler alternative to Vercel and Netlify, specialized for static website hosting. No build steps, no framework lock-in - just upload your files and get a live URL. Works great with sites built using AI tools like Lovable, Bolt, Cursor, and Claude.

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

## Authentication

1. Get your API key at [my.shipstatic.com/settings](https://my.shipstatic.com/settings)
2. In n8n, go to **Credentials > New Credential > ShipStatic API**
3. Paste your API key and save - n8n will verify the connection automatically

## Operations

### Deployments

| Operation | Description |
|-----------|-------------|
| **Upload** | Upload a directory and get a live URL |
| **Get Many** | List all deployments |
| **Get** | Get deployment details by ID |
| **Update** | Update deployment labels |
| **Delete** | Delete a deployment permanently |

### Domains

| Operation | Description |
|-----------|-------------|
| **Create or Update** | Create a domain, link it to a deployment, or update labels |
| **Get Many** | List all domains |
| **Get** | Get domain details by name |
| **Get DNS Records** | Get the DNS records you need to configure |
| **Validate** | Check if a domain name is valid and available |
| **Verify DNS** | Trigger DNS verification after configuring records |
| **Delete** | Delete a domain permanently |

### Account

| Operation | Description |
|-----------|-------------|
| **Get** | Get current account information |

## Example Workflows

### Publish a site

1. Add a **ShipStatic** node
2. Set Resource to **Deployment**, Operation to **Upload**
3. Enter the path to your build output directory
4. Run - you'll get back a live URL on `*.shipstatic.dev`

### Publish and connect a custom domain

1. **ShipStatic** → Upload deployment (get the deployment ID)
2. **ShipStatic** → Create or Update domain (link your domain to the deployment)
3. **ShipStatic** → Get DNS Records (get the records to configure)
4. Configure DNS with your provider
5. **ShipStatic** → Verify DNS (confirm everything is connected)

### Scheduled redeployment

Use an n8n **Schedule Trigger** to redeploy a site on a recurring basis - useful for sites that pull content from external sources.

## Dynamic Dropdowns

When selecting a deployment or domain, the node loads your existing resources as a dropdown for quick selection. You can also switch to expression mode to use dynamic values from previous nodes.

## AI Agent Support

This node works as a tool in n8n's AI Agent workflows (`usableAsTool: true`). Connect it to an AI agent and let it publish sites, manage domains, and check deployment status as part of a conversation.

## Resources

- [ShipStatic Documentation](https://docs.shipstatic.com)
- [ShipStatic Dashboard](https://my.shipstatic.com)
- [Report an Issue](https://github.com/shipstatic/node/issues)

## License

MIT
