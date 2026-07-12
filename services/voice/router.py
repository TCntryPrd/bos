from fastapi import FastAPI, Request, HTTPException
from fastapi.responses import JSONResponse
import requests
import logging
import os
from datetime import datetime
import asyncio
import aiohttp

# Set up logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

# Ensure logs directory exists
os.makedirs("/home/tcntryprd/boss-dev/logs", exist_ok=True)

app = FastAPI(title="IR Custom AIOS Voice Router", description="Routes voice commands to appropriate handlers")

# Configuration
BOSS_API_URL = os.environ.get("BOSS_API_URL", "http://127.0.0.1:8001/spoken-command")
# JWT_TOKEN is the master bearer for /spoken-command. Must be set via env;
# hardcoded fallback removed as part of secret rotation.
JWT_TOKEN = os.environ.get("BOSS_API_TOKEN", "")
if not JWT_TOKEN:
    logger.warning("BOSS_API_TOKEN not set — voice router will not authenticate against IR Custom AIOS API")
ALEXA_ENDPOINT = os.environ.get("ALEXA_ENDPOINT", "http://127.0.0.1:3000")
GOOGLE_ENDPOINT = os.environ.get("GOOGLE_ENDPOINT", "http://127.0.0.1:3001")

async def log_voice_command(source: str, command: str, response: str = None):
    """Log voice commands to the voice log file"""
    timestamp = datetime.now().isoformat()
    log_entry = f"[{timestamp}] {source}: {command}"
    if response:
        log_entry += f" -> {response[:100]}..."  # Limit response length in logs
    
    with open("/home/tcntryprd/boss-dev/logs/voice.log", "a", encoding="utf-8") as log_file:
        log_file.write(log_entry + "\n")

@app.get("/")
async def root():
    return {"message": "IR Custom AIOS Voice Router - Routes to Alexa and Google endpoints"}

@app.post("/alexa")
async def alexa_handler(request: Request):
    """Handle Alexa skill requests"""
    try:
        # Get the raw body for logging
        body_bytes = await request.body()
        body_str = body_bytes.decode('utf-8')
        
        # Parse the request to extract the intent/command
        import json
        req_data = json.loads(body_str)
        
        # Extract intent name and slots if available
        intent_name = None
        utterance = ""
        
        request_type = req_data.get('request', {}).get('type', '')
        if request_type == 'IntentRequest':
            intent_name = req_data.get('request', {}).get('intent', {}).get('name', '')
            slots = req_data.get('request', {}).get('intent', {}).get('slots', {})
            
            # Extract query slot if available
            if intent_name == 'IR Custom AIOSQueryIntent':
                utterance = slots.get('query', {}).get('value', '')
            elif intent_name == 'EmailCheckIntent':
                utterance = "Check my email"
            elif intent_name == 'BriefingIntent':
                utterance = "Give me my daily briefing"
            else:
                utterance = f"{intent_name} intent called"
        elif request_type == 'LaunchRequest':
            utterance = "Skill launched"
        else:
            utterance = f"{request_type} request"
        
        # Log the incoming command
        await log_voice_command("ALEXA", utterance)
        
        # Forward to local Alexa skill endpoint
        async with aiohttp.ClientSession() as session:
            async with session.post(
                f"{ALEXA_ENDPOINT}/", 
                data=body_bytes,
                headers={"Content-Type": "application/json"}
            ) as resp:
                response_data = await resp.text()
                
                # Log the response
                await log_voice_command("ALEXA", utterance, response_data[:200])
                
                return JSONResponse(content=json.loads(response_data))
    
    except Exception as e:
        logger.error(f"Error handling Alexa request: {str(e)}")
        await log_voice_command("ALEXA", "ERROR", str(e))
        raise HTTPException(status_code=500, detail=f"Error processing Alexa request: {str(e)}")

@app.post("/google/webhook")
@app.post("/google")
async def google_handler(request: Request):
    """Handle Google Assistant webhook requests"""
    try:
        # Get the raw body for logging
        body_bytes = await request.body()
        body_str = body_bytes.decode('utf-8')
        
        # Parse the request to extract the query
        import json
        req_data = json.loads(body_str)
        
        # Extract the query from the request
        query = req_data.get('queryResult', {}).get('queryText', '')
        intent_name = req_data.get('queryResult', {}).get('intent', {}).get('displayName', '')
        
        # Determine what to log based on intent
        if intent_name == 'boss.query':
            utterance = query
        elif intent_name == 'boss.email':
            utterance = "Check my email"
        elif intent_name == 'boss.briefing':
            utterance = "Give me my daily briefing"
        else:
            utterance = f"Google intent: {intent_name}"
        
        # Log the incoming command
        await log_voice_command("GOOGLE", utterance)
        
        # Forward to local Google webhook endpoint
        async with aiohttp.ClientSession() as session:
            async with session.post(
                f"{GOOGLE_ENDPOINT}/webhook", 
                data=body_bytes,
                headers={"Content-Type": "application/json"}
            ) as resp:
                response_data = await resp.text()
                
                # Log the response
                await log_voice_command("GOOGLE", utterance, response_data[:200])
                
                return JSONResponse(content=json.loads(response_data))
    
    except Exception as e:
        logger.error(f"Error handling Google request: {str(e)}")
        await log_voice_command("GOOGLE", "ERROR", str(e))
        raise HTTPException(status_code=500, detail=f"Error processing Google request: {str(e)}")

@app.get("/health")
async def health_check():
    """Health check endpoint"""
    return {"status": "healthy", "service": "voice-router"}

@app.get("/logs")
async def get_logs():
    """Return recent voice logs"""
    try:
        if os.path.exists("/home/tcntryprd/boss-dev/logs/voice.log"):
            with open("/home/tcntryprd/boss-dev/logs/voice.log", "r", encoding="utf-8") as log_file:
                lines = log_file.readlines()
                # Return last 20 lines
                recent_logs = lines[-20:] if len(lines) > 20 else lines
                return {"logs": [line.strip() for line in recent_logs]}
        else:
            return {"logs": []}
    except Exception as e:
        logger.error(f"Error reading logs: {str(e)}")
        return {"error": "Could not read logs", "details": str(e)}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=3002)