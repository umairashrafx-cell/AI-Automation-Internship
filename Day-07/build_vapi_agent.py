#!/usr/bin/env python3
"""Generates vapi/client-onboarding-agent.json and the tests/ payloads.

The assistant's system prompt is read from vapi/system-prompt.md so the two can
never drift apart. Edit the markdown, re-run this script, re-upload the JSON.

    python build_vapi_agent.py
"""
import json, pathlib

ROOT = pathlib.Path(__file__).resolve().parent
WEBHOOK = "https://REPLACE-WITH-YOUR-N8N-HOST/webhook/vapi-client-intake"

# ---- system prompt: everything after the '---' separator in system-prompt.md
md = (ROOT / "vapi" / "system-prompt.md").read_text(encoding="utf-8")
SYSTEM_PROMPT = md.split("\n---\n", 1)[1].strip()
assert SYSTEM_PROMPT.startswith("# IDENTITY"), SYSTEM_PROMPT[:80]

TOOL = {
    "type": "function",
    "async": False,
    "messages": [
        {"type": "request-start",
         "content": "Perfect, let me get that logged for you now."},
        {"type": "request-complete",
         "content": "All done. Your details are in our system."},
        {"type": "request-failed",
         "content": "I couldn't save that to our system just now, but I have your details written down and our team will follow up with you."},
        {"type": "request-response-delayed",
         "content": "Still saving that, one moment.",
         "timingMilliseconds": 8000},
    ],
    "function": {
        "name": "submit_client_onboarding",
        "description": (
            "Submits a new client enquiry to the agency's onboarding system. "
            "Call this exactly once, only after all six fields have been collected "
            "AND read back to the caller and confirmed by them."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "client_name": {
                    "type": "string",
                    "description": "The caller's own name. First name is enough, e.g. 'Ali'.",
                },
                "company_name": {
                    "type": "string",
                    "description": "The name of the caller's business or organisation, e.g. 'ABC Restaurant'.",
                },
                "email": {
                    "type": "string",
                    "description": (
                        "The caller's email address, lowercase, no spaces. Convert spoken "
                        "forms first: 'at' -> @, 'dot' -> '.', 'underscore' -> _. "
                        "Example: 'ali at abcrestaurant dot p k' -> 'ali@abcrestaurant.pk'."
                    ),
                },
                "service_required": {
                    "type": "string",
                    "description": (
                        "What the caller wants built, in their own words, e.g. 'website and "
                        "mobile app', 'e-commerce store', 'chatbot', 'branding'."
                    ),
                },
                "project_description": {
                    "type": "string",
                    "description": "One or two sentences describing the project and what it needs to do.",
                },
                "budget": {
                    "type": "number",
                    "description": (
                        "The budget in PKR as digits only - no commas, no currency symbol, "
                        "no words. 'five lakh' -> 500000, 'three lakh' -> 300000, "
                        "'one million' -> 1000000. Use 0 only if the caller genuinely "
                        "refuses to give any figure."
                    ),
                },
            },
            "required": [
                "client_name",
                "company_name",
                "email",
                "service_required",
                "project_description",
                "budget",
            ],
        },
    },
    "server": {"url": WEBHOOK, "timeoutSeconds": 30},
}

ASSISTANT = {
    "name": "Client Onboarding Agent",
    "firstMessage": (
        "Thanks for calling. I'm the onboarding assistant. "
        "I just need a few quick details about your project. Could I start with your name?"
    ),
    "firstMessageMode": "assistant-speaks-first",
    "model": {
        "provider": "openai",
        "model": "gpt-4o",
        "temperature": 0.3,
        "maxTokens": 300,
        "messages": [{"role": "system", "content": SYSTEM_PROMPT}],
        "tools": [TOOL],
    },
    "voice": {
        "provider": "vapi",
        "voiceId": "Neha",
    },
    "transcriber": {
        "provider": "deepgram",
        "model": "nova-2",
        "language": "en",
        "smartFormat": True,
    },
    "endCallMessage": (
        "Thanks again. Our team has your details and someone will be in touch shortly. Goodbye."
    ),
    "endCallPhrases": ["goodbye", "bye bye", "that's all thanks", "talk to you later"],
    "endCallFunctionEnabled": True,
    "silenceTimeoutSeconds": 30,
    "maxDurationSeconds": 300,
    "backgroundSound": "office",
    "backchannelingEnabled": True,
    "backgroundDenoisingEnabled": True,
    # Deliberately empty: the tool call above already POSTs to n8n. If an
    # end-of-call-report were also sent to the same webhook, n8n would create a
    # second Airtable row and Notion page for the same caller.
    "serverMessages": [],
    "analysisPlan": {
        "summaryPlan": {"enabled": True},
        "structuredDataPlan": {
            "enabled": True,
            "schema": {
                "type": "object",
                "properties": {
                    "client_name": {"type": "string"},
                    "company_name": {"type": "string"},
                    "email": {"type": "string"},
                    "service_required": {"type": "string"},
                    "project_description": {"type": "string"},
                    "budget": {"type": "number"},
                },
            },
        },
        "successEvaluationPlan": {
            "enabled": True,
            "rubric": "PassFail",
        },
    },
}


def tool_call_payload(call_id, tool_call_id, args, as_string=False):
    return {
        "message": {
            "type": "tool-calls",
            "call": {"id": call_id, "type": "inboundPhoneCall"},
            "toolCalls": [
                {
                    "id": tool_call_id,
                    "type": "function",
                    "function": {
                        "name": "submit_client_onboarding",
                        "arguments": json.dumps(args) if as_string else args,
                    },
                }
            ],
        }
    }


TESTS = {
    "test-1-high.json": tool_call_payload(
        "call_test_high_001", "toolu_high_001",
        {
            "client_name": "Ali",
            "company_name": "ABC Restaurant",
            "email": "ali@abcrestaurant.pk",
            "service_required": "website and mobile app for online ordering",
            "project_description": "A restaurant website plus a mobile application so customers can browse the menu and place orders online.",
            "budget": 600000,
        },
    ),
    "test-2-medium.json": tool_call_payload(
        "call_test_medium_002", "toolu_medium_002",
        {
            "client_name": "Sara",
            "company_name": "Noor Fashion House",
            "email": "sara@noorfashion.pk",
            "service_required": "e-commerce website with payment integration",
            "project_description": "An online clothing store with a product catalogue, cart and integrated online payments.",
            "budget": 300000,
        },
    ),
    # arguments sent as a JSON *string* - the other shape Vapi uses
    "test-3-low.json": tool_call_payload(
        "call_test_low_003", "toolu_low_003",
        {
            "client_name": "Bilal",
            "company_name": "Bilal Auto Works",
            "email": "bilal@bilalautoworks.pk",
            "service_required": "simple one page website",
            "project_description": "A single page website for a car workshop with a contact form so customers can request a booking.",
            "budget": 100000,
        },
        as_string=True,
    ),
    # flat body, budget as spoken text - exercises the budget parser
    "test-4-flat-payload.json": {
        "client_name": "Hina",
        "company_name": "Hina Interiors",
        "email": "  Hina@HinaInteriors.PK ",
        "service_required": "portfolio website",
        "project_description": "A portfolio site to showcase completed interior design projects with an enquiry form.",
        "budget": "4 lakh",
        "call_id": "call_test_flat_004",
    },
}


def write(path, obj):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print("wrote", path.relative_to(ROOT))


write(ROOT / "vapi" / "client-onboarding-agent.json", ASSISTANT)
for name, payload in TESTS.items():
    write(ROOT / "tests" / name, payload)
