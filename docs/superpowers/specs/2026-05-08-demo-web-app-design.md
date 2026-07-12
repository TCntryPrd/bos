---
title: Simple Demo Web App
date: 2026-05-08
status: approved
---

# Simple Demo Web App Design

## Purpose
Create a simple "Hello World" web page with interactive buttons for live demonstration, accessible via IP address.

## Architecture
- Single self-contained HTML file (`demo.html`)
- Inline CSS for styling
- Inline JavaScript for interactivity
- Served via Python 3 `http.server` on port 3000
- Accessible at `http://172.22.0.7:3000/demo.html`

## Features
1. **Hello World Display** - Prominent heading with welcome message
2. **Click Counter Button** - Increments counter on each click
3. **Color Change Button** - Randomly changes background color
4. **Alert Button** - Shows browser popup message

## Implementation
- Create `/home/tcntryprd/boss-dev/demo.html`
- Start Python HTTP server: `python3 -m http.server 3000`
- Provide IP address to user

## Success Criteria
- Page loads at specified IP address
- All three buttons work with visual feedback
- No external dependencies required
