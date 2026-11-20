![Zonely MCP — Manage your Zonely site with an AI assistant](assets/zonely-mcp-cover.png)

# Zonely MCP

Connect your Zonely control panel to an AI assistant. Manage your site, find answers in the official Zonely documentation, and develop custom PHP modules from the same conversation.

[Download Zonely MCP](https://github.com/zonely-gen-tr/zonely-mcp/releases/latest) · [Zonely documentation](https://docs.zonely.gen.tr/) · [Report an issue](https://github.com/zonely-gen-tr/zonely-mcp/issues)

## What you can do

| Area | Example workflows |
| --- | --- |
| **Control panel** | Publish announcements, update site titles and menus, organize support and community categories, and look up member, order, or activity records. |
| **Store and game servers** | Create product categories, membership tiers, and in-game products. Set up supported payment and game-delivery integrations using the settings available on your site. |
| **Media library** | Upload site artwork, verify its published URL, and reuse the image in a page, announcement, or template. |
| **Themes** | Create a private theme draft, edit supported templates, or use authorized SFTP access to build a homepage for your server. Read the saved result before publishing. |
| **PHP modules** | Read Zonely's module rules, develop a PHP module and its templates, and prepare a ZIP for panel validation. Build a companion game-server plugin when the feature needs one. |
| **Documentation** | Find relevant setup guides and panel workflows in 19 documentation languages. Ask what a setting does or what to configure next. |

The customer package exposes 48 MCP tools. Available actions depend on your site version, enabled features, connected integrations, and account permissions.

## Installation

1. Download the customer ZIP from [Releases](https://github.com/zonely-gen-tr/zonely-mcp/releases/latest) and extract it. Manual setup requires Node.js 24 or later.
2. Open the extracted folder in Codex and ask: **“Install Zonely MCP for my site and use English for the documentation.”** Follow the setup instructions included in the package.
3. Link your site profile and sign in to your Zonely panel when prompted. Try **“List the latest announcements on my site.”**

The package also includes local MCP setup instructions for Claude Code and other clients that support local stdio servers.

### Starting a new site

Ask for a trial preview for a domain you control. Sign in to your Zonely account and confirm the domain and the zero total before applying. The account's DNS guide then shows how to connect your domain. Once your site is ready, link it to your assistant.

## Example requests

> Create a private BoxPvP theme draft. Add an arena introduction and feature existing store products on the homepage.

> Upload this image to the media library, verify its published link, and use it on my game card.

> Check the module development guide. Design a player-activity map with a PHP module, a database, and a companion game-server plugin.

> Review my Survival store plan before creating the categories and membership tiers.

## Help and documentation

Use the official [Zonely documentation](https://docs.zonely.gen.tr/) for platform guides. The release ZIP includes client setup and connection instructions. For a release issue, include your MCP client and the operation you were trying to complete.
