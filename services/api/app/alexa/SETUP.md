# Alexa Skill Setup — IR Custom AIOS

## Prerequisites
- Amazon Developer account (developer.amazon.com) — same account as your Alexa devices
- IR Custom AIOS API running with Funnel enabled

## Step 1: Create the Skill

1. Go to https://developer.amazon.com/alexa/console/ask
2. Click **Create Skill**
3. Skill name: **IR Custom AIOS**
4. Default language: **English (US)**
5. Choose model: **Custom**
6. Hosting: **Provision your own** (we host on last-castle)
7. Click **Create Skill**
8. Choose template: **Start from Scratch**

## Step 2: Set Up Interaction Model

1. In the left sidebar, click **JSON Editor** (under Interaction Model)
2. Paste the contents of `skill-package/interaction-model.json`
3. Click **Save Model**
4. Click **Build Model** (wait for it to complete)

## Step 3: Set Up Endpoint

1. In the left sidebar, click **Endpoint**
2. Select **HTTPS**
3. Default Region: `https://last-castle.daggertooth-larch.ts.net/boss/alexa/webhook`
4. SSL Certificate type: **My development endpoint has a certificate from a trusted certificate authority**
   (Tailscale Funnel provides valid TLS)
5. Click **Save Endpoints**

## Step 4: Test

1. Go to **Test** tab at the top
2. Enable testing: **Development**
3. Type or say: "open boss"
4. You should get: "IR Custom AIOS is connected. What can I help you with?"
5. Then: "what's on my schedule"
6. You should get your real calendar data

## Step 5: Enable on Your Devices

Since the skill is in Development mode and created under your Amazon account,
it's automatically available on all Alexa devices linked to that account.

Just say: "Alexa, open IR Custom AIOS"

## For BSC/Brad

1. Clone this skill
2. Change invocation name to "brad" in the interaction model
3. Update the endpoint URL to the BSC instance
4. For distribution: submit for Alexa Skill certification

## Endpoint URL
```
https://last-castle.daggertooth-larch.ts.net/boss/alexa/webhook
```
