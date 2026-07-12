# IR Custom AIOS Core — Design Document

**Date:** 2026-03-27
**Author:** Claude Code (Lead Engineer)
**Approved by:** Kevin Starr

## Vision
IR Custom AIOS is a fully autonomous self-healing orchestration system — an AIOS. It watches every connected service, reacts to events autonomously, executes via OpenClaw, and only escalates to humans when genuinely necessary. Packageable for clients (BSC/Brad is the first fork).

## Architecture
Event-driven autonomous agent mesh: Connectors watch external services → Event Bus (Redis Streams) → Rule Engine evaluates and dispatches → OpenClaw executes → Results logged → Humans escalated only when needed.

## New Services
- boss_reactor: Event bus consumer, rule engine, action dispatcher
- boss_connectors: Polls/webhooks external services, emits events to bus

## Approved for immediate implementation.
