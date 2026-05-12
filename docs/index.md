# Saivage v3

An autonomous multi-agent system for software development.

## What is Saivage?

Saivage is an autonomous multi-agent system that uses a **Planner → Manager → Workers** architecture to execute software development tasks. It maintains a persistent card store, supports plan-driven execution, and provides a Fastify-based API server with WebSocket events.

## Quick Links

- **[Installation Guide](/install)** — Set up Saivage v3 from a clean checkout
- **[Configuration Reference](/configuration)** — Configure models, providers, MCP servers, Telegram, and notifications
- **[Operation Guide](/operation)** — Runtime management, API usage, backup, and recovery
- **[Operator Runbook](/operator-runbook)** — Day-to-day operator procedures
- **[Troubleshooting](/troubleshooting)** — Common issues and their solutions
- **[Release Checklist](/release-checklist)** — Steps to create a new release

## Architecture

Saivage uses a multi-agent architecture with these key roles:

- **Planner** — Top-level strategist that creates multi-stage plans
- **Manager** — Tactical executor that decomposes stages into tasks
- **Coder** — One-shot coding agent for code modifications
- **Researcher** — One-shot agent for information gathering

The system maintains all state in a project-local `.saivage` directory using a JSON-based card store.
