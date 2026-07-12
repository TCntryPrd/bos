import logging
import os
import json
import requests
from ask_sdk_core.skill_builder import SkillBuilder
from ask_sdk_core.dispatch_components import AbstractRequestHandler
from ask_sdk_core.utils import is_request_type, get_slot_value
from ask_sdk_model import Response
from ask_sdk_core.utils import get_logger

logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)

# Configuration
BOSS_API_URL = os.environ.get("BOSS_API_URL", "http://127.0.0.1:8001/spoken-command")
# Hardcoded token literal removed — must be set via BOSS_API_TOKEN env var.
JWT_TOKEN = os.environ.get("BOSS_API_TOKEN", "")
if not JWT_TOKEN:
    logger.warning("BOSS_API_TOKEN not set — Alexa skill will not authenticate against IR Custom AIOS API")

class LaunchRequestHandler(AbstractRequestHandler):
    """Handler for Skill Launch."""
    def can_handle(self, handler_input):
        return is_request_type("LaunchRequest")(handler_input)

    def handle(self, handler_input):
        speech_text = "Welcome to IR Custom AIOS. How can I assist you today?"
        return (
            handler_input.response_builder
                .speak(speech_text)
                .ask(speech_text)
                .response
        )

class IR Custom AIOSQueryIntentHandler(AbstractRequestHandler):
    """Handler for IR Custom AIOS Query Intent."""
    def can_handle(self, handler_input):
        return is_request_type("IntentRequest")(handler_input) and \
               get_slot_value(handler_input, "intent_name") == "IR Custom AIOSQueryIntent"

    def handle(self, handler_input):
        query = get_slot_value(handler_input, "query")
        
        if not query:
            speech_text = "I didn't catch your query. Please try again."
            return (
                handler_input.response_builder
                    .speak(speech_text)
                    .ask("Please ask me something.")
                    .response
            )
        
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
            speech_text = result.get("response", "I couldn't process your request right now.")
        except Exception as e:
            logger.error(f"Error calling IR Custom AIOS API: {str(e)}")
            speech_text = "Sorry, I'm having trouble connecting to the service. Please try again later."
        
        return (
            handler_input.response_builder
                .speak(speech_text)
                .response
        )

class EmailCheckIntentHandler(AbstractRequestHandler):
    """Handler for Email Check Intent."""
    def can_handle(self, handler_input):
        return is_request_type("IntentRequest")(handler_input) and \
               get_slot_value(handler_input, "intent_name") == "EmailCheckIntent"

    def handle(self, handler_input):
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
            speech_text = result.get("response", "I couldn't check your email right now.")
        except Exception as e:
            logger.error(f"Error calling IR Custom AIOS API: {str(e)}")
            speech_text = "Sorry, I'm having trouble connecting to the service to check your email."
        
        return (
            handler_input.response_builder
                .speak(speech_text)
                .response
        )

class BriefingIntentHandler(AbstractRequestHandler):
    """Handler for Briefing Intent."""
    def can_handle(self, handler_input):
        return is_request_type("IntentRequest")(handler_input) and \
               get_slot_value(handler_input, "intent_name") == "BriefingIntent"

    def handle(self, handler_input):
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
            speech_text = result.get("response", "I couldn't generate your briefing right now.")
        except Exception as e:
            logger.error(f"Error calling IR Custom AIOS API: {str(e)}")
            speech_text = "Sorry, I'm having trouble connecting to the service to get your briefing."
        
        return (
            handler_input.response_builder
                .speak(speech_text)
                .response
        )

class HelpIntentHandler(AbstractRequestHandler):
    """Handler for Help Intent."""
    def can_handle(self, handler_input):
        return is_request_type("IntentRequest")(handler_input) and \
               get_slot_value(handler_input, "intent_name") == "AMAZON.HelpIntent"

    def handle(self, handler_input):
        speech_text = "You can ask me anything about your business. Try saying, 'What's my email?' or 'Give me my daily briefing.'"
        return (
            handler_input.response_builder
                .speak(speech_text)
                .ask(speech_text)
                .response
        )

class CancelOrStopIntentHandler(AbstractRequestHandler):
    """Single handler for Cancel and Stop Intent."""
    def can_handle(self, handler_input):
        return (is_request_type("IntentRequest")(handler_input) and
                get_slot_value(handler_input, "intent_name") in ["AMAZON.CancelIntent", "AMAZON.StopIntent"])

    def handle(self, handler_input):
        speech_text = "Goodbye!"
        return (
            handler_input.response_builder
                .speak(speech_text)
                .response
        )

class SessionEndedRequestHandler(AbstractRequestHandler):
    """Handler for Session End."""
    def can_handle(self, handler_input):
        return is_request_type("SessionEndedRequest")(handler_input)

    def handle(self, handler_input):
        return handler_input.response_builder.response

class CatchAllExceptionHandler(AbstractExceptionHandler):
    """Generic error handling to capture any syntax or routing errors."""
    def can_handle(self, handler_input, exception):
        return True

    def handle(self, handler_input, exception):
        logger.error(exception, exc_info=True)
        speech_text = "Sorry, I had trouble processing your request. Please try again."

        return (
            handler_input.response_builder
                .speak(speech_text)
                .ask(speech_text)
                .response
        )

# The Skill Builder object acts as the entry point for your skill, routing all request and response
# payloads to the handlers above. Make sure any new handlers or interceptors you've
# defined are included below. The order matters - they're processed top to bottom.

sb = SkillBuilder()

# Register intent handlers
sb.add_request_handler(LaunchRequestHandler())
sb.add_request_handler(IR Custom AIOSQueryIntentHandler())
sb.add_request_handler(EmailCheckIntentHandler())
sb.add_request_handler(BriefingIntentHandler())
sb.add_request_handler(HelpIntentHandler())
sb.add_request_handler(CancelOrStopIntentHandler())
sb.add_request_handler(SessionEndedRequestHandler())

# Register exception handler
sb.add_exception_handler(CatchAllExceptionHandler())

lambda_handler = sb.lambda_handler()