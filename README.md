# pi-opencodego-usage

OpenCode Go subscription usage monitor for Pi.

Displays monthly, 5-hour and weekly rolling quota in the footer when using the OpenCode Go provider.

## Features

- Footer display for monthly, 5-hour and weekly usage
- `/opencodego` command to view quota details
- Automatic idle refresh

## Authentication

Reads the OpenCode API key from:
- `OPENCODE_API_KEY` environment variable
- `~/.pi/agent/auth.json` (`opencode-go`)

## Install

```bash
pi install git:github.com/inouemoby/pi-opencodego-usage
```
