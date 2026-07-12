import logging
import os
import json
import requests
from flask import Flask, request, jsonify

app = Flask(__name__)
logging.basicConfig(level=logging.DEBUG)

# Configuration
BOSS_API_URL = os.environ.get("BOSS_API_URL", "http://127.0.0.1:8001/spoken-command")
# Hardcoded token literal removed — must be set via BOSS_API_TOKEN env var.
JWT_TOKEN = os.environ.get("BOSS_API_TOKEN", "")
if not JWT_TOKEN:
    app.logger.warning("BOSS_API_TOKEN not set — Google webhook will not authenticate against IR Custom AIOS API")

@app.route('/webhook', methods=['POST'])
def webhook():
    """Webhook endpoint for Dialogflow fulfillment"""
    req = request.get_json(force=True)
    
    # Extract the intent name
    intent_name = req.get('queryResult', {}).get('intent', {}).get('displayName', '')
    
    # Handle different intents
    if intent_name == 'boss.query':
        return handle_boss_query(req)
    elif intent_name == 'boss.email':
        return handle_email_check(req)
    elif intent_name == 'boss.briefing':
        return handle_briefing(req)
    else:
        # Default fallback response
        return jsonify({
            'fulfillmentText': 'I\'m not sure how to help with that. Try asking about your email or daily briefing.'
        })

def handle_boss_query(req):
    """Handle general IR Custom AIOS queries"""
    query = req.get('queryResult', {}).get('queryText', '')
    
    if not query:
        return jsonify({
            'fulfillmentText': 'I didn\'t catch your query. Please try again.'
        })
    
    # Send query to IR Custom AIOS API
    headers = {
        "Authorization": f"Bearer {JWT_TOKEN}",
        "Content-Type": "application/json"
    }
    payload = {"text": query}
    
    try:
        response = requests.post(BOSS_API_URL, headers=headers, json=payload, timeout=30)
        response.raise_for_status()
        
        result = response.json()
        response_text = result.get("response", "I couldn't process your request right now.")
    except Exception as e:
        app.logger.error(f"Error calling IR Custom AIOS API: {str(e)}")
        response_text = "Sorry, I'm having trouble connecting to the service. Please try again later."
    
    return jsonify({
        'fulfillmentText': response_text,
        'fulfillmentMessages': [
            {
                'text': {
                    'text': [response_text]
                }
            }
        ]
    })

def handle_email_check(req):
    """Handle email check requests"""
    query = "Check my email"
    
    # Send query to IR Custom AIOS API
    headers = {
        "Authorization": f"Bearer {JWT_TOKEN}",
        "Content-Type": "application/json"
    }
    payload = {"text": query}
    
    try:
        response = requests.post(BOSS_API_URL, headers=headers, json=payload, timeout=30)
        response.raise_for_status()
        
        result = response.json()
        response_text = result.get("response", "I couldn't check your email right now.")
    except Exception as e:
        app.logger.error(f"Error calling IR Custom AIOS API: {str(e)}")
        response_text = "Sorry, I'm having trouble connecting to the service to check your email."
    
    return jsonify({
        'fulfillmentText': response_text,
        'fulfillmentMessages': [
            {
                'text': {
                    'text': [response_text]
                }
            }
        ]
    })

def handle_briefing(req):
    """Handle daily briefing requests"""
    query = "Give me my daily briefing"
    
    # Send query to IR Custom AIOS API
    headers = {
        "Authorization": f"Bearer {JWT_TOKEN}",
        "Content-Type": "application/json"
    }
    payload = {"text": query}
    
    try:
        response = requests.post(BOSS_API_URL, headers=headers, json=payload, timeout=30)
        response.raise_for_status()
        
        result = response.json()
        response_text = result.get("response", "I couldn't generate your briefing right now.")
    except Exception as e:
        app.logger.error(f"Error calling IR Custom AIOS API: {str(e)}")
        response_text = "Sorry, I'm having trouble connecting to the service to get your briefing."
    
    return jsonify({
        'fulfillmentText': response_text,
        'fulfillmentMessages': [
            {
                'text': {
                    'text': [response_text]
                }
            }
        ]
    })

@app.route('/health', methods=['GET'])
def health():
    """Health check endpoint"""
    return jsonify({'status': 'healthy'}), 200

if __name__ == '__main__':
    app.run(debug=True, host='0.0.0.0', port=3001)