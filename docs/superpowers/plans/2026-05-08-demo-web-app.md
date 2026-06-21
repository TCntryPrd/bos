# Demo Web App Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create a self-contained interactive "Hello World" web page accessible via server IP for live demonstration.

**Architecture:** Single HTML file with inline CSS and JavaScript, served via Python's built-in HTTP server on port 3000.

**Tech Stack:** HTML5, CSS3, JavaScript (vanilla), Python 3 http.server

---

## File Structure

**New Files:**
- `demo.html` - Self-contained web page with all styling and interactivity

**No modifications** to existing files needed.

---

## Task 1: Create Interactive HTML Page

**Files:**
- Create: `demo.html`

- [ ] **Step 1: Create the HTML file with structure and styling**

Create `demo.html` in the project root:

```html
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Hello World Demo</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        
        body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            display: flex;
            justify-content: center;
            align-items: center;
            min-height: 100vh;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            transition: background 0.5s ease;
        }
        
        .container {
            background: white;
            padding: 3rem;
            border-radius: 20px;
            box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
            text-align: center;
            max-width: 500px;
            width: 90%;
        }
        
        h1 {
            color: #333;
            font-size: 3rem;
            margin-bottom: 1rem;
        }
        
        p {
            color: #666;
            font-size: 1.2rem;
            margin-bottom: 2rem;
        }
        
        .button-group {
            display: flex;
            flex-direction: column;
            gap: 1rem;
        }
        
        button {
            padding: 1rem 2rem;
            font-size: 1.1rem;
            font-weight: bold;
            border: none;
            border-radius: 10px;
            cursor: pointer;
            transition: all 0.3s ease;
            color: white;
        }
        
        button:hover {
            transform: translateY(-2px);
            box-shadow: 0 5px 15px rgba(0, 0, 0, 0.2);
        }
        
        button:active {
            transform: translateY(0);
        }
        
        .counter-btn {
            background: #4CAF50;
        }
        
        .counter-btn:hover {
            background: #45a049;
        }
        
        .color-btn {
            background: #2196F3;
        }
        
        .color-btn:hover {
            background: #0b7dda;
        }
        
        .alert-btn {
            background: #ff9800;
        }
        
        .alert-btn:hover {
            background: #e68900;
        }
        
        #counter-display {
            font-size: 1.5rem;
            color: #4CAF50;
            font-weight: bold;
            margin-top: 0.5rem;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>Hello World!</h1>
        <p>Welcome to the interactive demo page</p>
        
        <div class="button-group">
            <button class="counter-btn" onclick="incrementCounter()">
                Click Counter
            </button>
            <div id="counter-display">Clicks: 0</div>
            
            <button class="color-btn" onclick="changeColor()">
                Change Background Color
            </button>
            
            <button class="alert-btn" onclick="showAlert()">
                Show Alert
            </button>
        </div>
    </div>

    <script>
        let clickCount = 0;
        
        function incrementCounter() {
            clickCount++;
            document.getElementById('counter-display').textContent = `Clicks: ${clickCount}`;
        }
        
        function changeColor() {
            const colors = [
                'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
                'linear-gradient(135deg, #f093fb 0%, #f5576c 100%)',
                'linear-gradient(135deg, #4facfe 0%, #00f2fe 100%)',
                'linear-gradient(135deg, #43e97b 0%, #38f9d7 100%)',
                'linear-gradient(135deg, #fa709a 0%, #fee140 100%)',
                'linear-gradient(135deg, #30cfd0 0%, #330867 100%)',
                'linear-gradient(135deg, #a8edea 0%, #fed6e3 100%)',
                'linear-gradient(135deg, #ff9a9e 0%, #fecfef 100%)'
            ];
            
            const randomColor = colors[Math.floor(Math.random() * colors.length)];
            document.body.style.background = randomColor;
        }
        
        function showAlert() {
            alert('👋 Hello from the demo app! This is an interactive JavaScript alert.');
        }
    </script>
</body>
</html>
```

- [ ] **Step 2: Verify file was created**

Run: `ls -lh demo.html`
Expected: File exists, approximately 4-5KB in size

---

## Task 2: Start Python HTTP Server

**Files:**
- No file changes, server startup only

- [ ] **Step 1: Start the HTTP server on port 3000**

Run in background: `cd /home/tcntryprd/boss-dev && python3 -m http.server 3000 > /dev/null 2>&1 &`

- [ ] **Step 2: Verify server is running**

Run: `netstat -tuln | grep 3000`
Expected: Output showing `0.0.0.0:3000` in LISTEN state

- [ ] **Step 3: Get the server PID for reference**

Run: `ps aux | grep "http.server 3000" | grep -v grep`
Expected: Process listing with PID

---

## Task 3: Verify Accessibility and Provide Access Information

**Files:**
- No file changes

- [ ] **Step 1: Test local access**

Run: `curl -s http://localhost:3000/demo.html | head -5`
Expected: HTML content starting with `<!DOCTYPE html>`

- [ ] **Step 2: Confirm server IP address**

Run: `ip addr show | grep "inet " | grep -v 127.0.0.1`
Expected: Server IP `172.22.0.7/16`

- [ ] **Step 3: Provide access URL to user**

The demo app is accessible at: **`http://172.22.0.7:3000/demo.html`**

Features:
- Click Counter button increments a counter
- Change Background Color button randomly changes the page background
- Show Alert button displays a browser popup

---

## Self-Review Checklist

**Spec Coverage:**
- ✅ Hello World Display - Implemented in h1 and p tags
- ✅ Click Counter Button - incrementCounter() function with display
- ✅ Color Change Button - changeColor() function with 8 gradient options
- ✅ Alert Button - showAlert() function with browser alert
- ✅ Single self-contained file - All CSS and JS inline
- ✅ Python HTTP server on port 3000 - Task 2
- ✅ Accessible at 172.22.0.7:3000 - Task 3

**Placeholders:** None - all code is complete and functional

**Type Consistency:** N/A - no complex type system, simple HTML/JS

**Missing Requirements:** None

---

## Notes

- Server runs in background and will persist until stopped or container restart
- To stop server later: `pkill -f "http.server 3000"`
- No external dependencies required
- Page works in all modern browsers
