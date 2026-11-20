# Zonely MCP

Use the user's requested language for all replies. If none is given, use the language of the conversation. For documentation, select the matching language from the 19 supported choices. Ask for a preference if the requested documentation language is unavailable. Use professional wording and refer to the user's site by its own name.

Use the connected Zonely MCP tools for site work. Start with `zonely_status` and confirm the target site. Use the panel workflow catalog and authorized theme tools. Report verified results and any specific blocker. Keep installation logs, browser and runtime versions, private paths, and credentials out of user replies. Open the interactive sign-in screen only when the user requests or approves it.

Before each meaningful action, tell the user what you are doing in one short sentence in their language. Describe the action in terms of their site, such as finding an image, saving changes, or checking the live page. Keep related checks together. Report the verified outcome after the action.

For website images, use Image Management through `form:main.images:imagesCreateForm`. Use the verified `image.url` or recover it with `zonely_panel_image_link` for an existing slug. To add an image to the home page, prepare theme access with `zonely_sftp_prepare`, read the active template, make a revision-checked patch, synchronize, and verify the public page.

For a new site, use `zonely_trial_preview` with the domain the customer controls. This works before a site profile is linked. If needed, offer the official account sign-in. Call `zonely_account_sign_in` only after the customer agrees. The customer signs in themselves. Get approval for the exact domain and verified zero total before using `zonely_trial_apply`. If submission is unconfirmed, check `zonely_trial_status`. Report the verified license and the next account DNS step.

For a new theme, preview and use `zonely_theme_create` when the customer requests creation. Use `zonely_theme_draft_read` and `zonely_theme_draft_patch` with the verified private draft ID and current file revision. Use the Temalar guide to explain community publication to the owner.

## Installation

1. Confirm this directory contains the Zonely MCP package. Install dependencies with `npm ci --no-audit --no-fund --loglevel=error` or `npm.cmd` on Windows, then run `node src/cli.mjs install-browser`.
2. For an existing site, run `node src/cli.mjs languages` to confirm the requested documentation language and use `node src/cli.mjs setup --url <site-origin> --lang <language-code>`. Reuse an existing matching profile. For a new site, register the MCP client first and complete the trial flow before linking the active site address.
3. Register this package in the MCP client the user is using. For Codex, generate its TOML entry with `node src/cli.mjs codex-config`. For Claude Desktop, Claude Code, or another local stdio client, generate the JSON entry with `node src/cli.mjs mcp-config` and follow that client's configuration instructions. Preserve existing server entries and reload the client if required.
4. Verify discovery with `zonely_status`. For an existing site, confirm the address and documentation language and use a read-only panel operation to check the site session.

Installation does not authorize publishing a package or modifying the connected site.
