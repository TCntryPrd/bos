"""
Firebase Cloud Messaging server-side integration for IR Custom AIOS.
Provides function to send push notifications to mobile devices.
"""

import os
import requests
import logging
from typing import Optional

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

FCM_SERVER_KEY = os.getenv('FCM_SERVER_KEY')
FCM_DEVICE_TOKEN = os.getenv('FCM_DEVICE_TOKEN')


def send_push(title: str, body: str, device_token: Optional[str] = None) -> dict:
    """
    Send FCM notification to a device.
    
    Args:
        title: Notification title
        body: Notification body
        device_token: Target device token (uses default if not provided)
    
    Returns:
        Response from FCM server
    """
    target_token = device_token or FCM_DEVICE_TOKEN
    
    if not target_token:
        logger.error("No device token provided and no default FCM_DEVICE_TOKEN set")
        return {"error": "No device token provided"}
    
    if not FCM_SERVER_KEY:
        logger.error("FCM_SERVER_KEY not set in environment variables")
        return {"error": "FCM server key not configured"}
    
    url = "https://fcm.googleapis.com/fcm/send"
    
    headers = {
        'Authorization': f'key={FCM_SERVER_KEY}',
        'Content-Type': 'application/json'
    }
    
    payload = {
        'to': target_token,
        'notification': {
            'title': title,
            'body': body,
            'sound': 'default'
        },
        'data': {
            'title': title,
            'body': body
        }
    }
    
    try:
        response = requests.post(url, headers=headers, json=payload)
        response.raise_for_status()
        
        logger.info(f"Push notification sent successfully: {title}")
        return {
            "status": "success",
            "response": response.json(),
            "target_token": target_token
        }
    except requests.exceptions.RequestException as e:
        logger.error(f"Failed to send push notification: {str(e)}")
        return {
            "status": "failed",
            "error": str(e),
            "target_token": target_token
        }


if __name__ == "__main__":
    # Test the function
    result = send_push("Test Title", "Test Body")
    print(result)