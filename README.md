# Live Market Stream

Create a NEW standalone project called:

RB Live Engine

IMPORTANT

This is NOT a frontend application.

This is NOT a React project.

This is NOT a Lovable UI.

This is NOT an Edge Function.

This is a standalone Node.js + TypeScript backend service that runs continuously (24x7).

==================================================

PURPOSE

This service will become the permanent Market Data Engine for the Ratan Bullion platform.

It must receive live market data from Angel One SmartAPI WebSocket and synchronize it to Supabase in real time.

The existing frontend application (Ratan Connect Hub) MUST NOT be modified.

This backend will only write data into Supabase.

The frontend will continue reading from Supabase exactly as it does today.

==================================================

TECH STACK

Node.js

TypeScript

Docker

dotenv

Supabase JS SDK

No React

No HTML

No CSS

No UI

==================================================

PROJECT STRUCTURE

src/

config/

providers/

engine/

services/

models/

utils/

logs/

index.ts

==================================================

PROVIDER ARCHITECTURE

Create a provider interface.

Do NOT hardcode Angel One everywhere.

Future providers should plug in without changing the engine.

Examples:

Angel One

Metals API

MCX Vendor

REST APIs

WebSocket APIs

==================================================

ANGEL ONE MODULE

Create a dedicated Angel One provider.

Responsibilities:

Login

Generate JWT

Generate Feed Token

Create WebSocket connection

Subscribe to instruments

Reconnect automatically

Resubscribe after reconnect

Heartbeat

Connection monitoring

==================================================

CONFIGURATION

Everything must come from .env

No credentials in source code.

Required variables:

SUPABASE_URL

SUPABASE_SERVICE_ROLE_KEY

ANGEL_API_KEY

ANGEL_CLIENT_CODE

ANGEL_PIN

ANGEL_TOTP_SECRET

==================================================

MARKET ENGINE

The engine should continuously receive live ticks.

Each tick must go through a processing pipeline.

Pipeline:

Receive Tick

Validate

Normalize

Timestamp

Queue

Database Writer

Realtime Broadcast

==================================================

SUPABASE WRITER

Update these existing tables only.

public.rates

public.rates_history

public.market_candles

Do NOT change their schema.

Use UPSERT where appropriate.

==================================================

CANDLE ENGINE

Generate

1 Minute OHLC

Design the engine so future support can be added for:

5 Minute

15 Minute

30 Minute

1 Hour

Daily

==================================================

HEALTH SERVICE

Expose

GET /health

Response should include

Connected

Provider Name

Current Contract

Last Tick Time

Ticks Received

Database Status

Reconnect Count

Engine Uptime

==================================================

LOGGING

Log

Startup

Login

Connection

Disconnection

Reconnect

Subscription

Tick Count

Database Writes

Errors

Warnings

==================================================

ERROR RECOVERY

If WebSocket disconnects

Reconnect automatically.

After reconnect

Automatically subscribe again.

No manual intervention.

==================================================

FUTURE REQUIREMENTS

This engine will later support

Technical Indicators

AI Analysis

Market Insights

Signal Generation

Multiple Exchanges

Multiple Providers

Therefore architecture must be modular and scalable.

==================================================

OUTPUT

Generate a complete production-ready backend project.

Include:

package.json

tsconfig.json

Dockerfile

.env.example

README.md

Folder structure

Source files

Startup instructions

Do NOT generate any frontend.

Do NOT modify Ratan Connect Hub.

This project will become the dedicated Live Market Engine for the entire bullion platform.

This project was built with [Lovable](https://lovable.dev).

## Build with Lovable

Continue developing this project in the [Lovable editor](https://lovable.dev/projects/5d9c7954-f93d-4a03-9128-13b03f03b325).

- **Ship faster**: describe what you want to build and Lovable handles the code.
- **Stay in sync**: every change made in Lovable is committed straight to this repository.
- **Full ownership**: this code is yours. Push to `main` on GitHub and your changes sync back into Lovable, ready for your next prompt.

## Development

Prefer working locally? You need Node.js and npm — [install with nvm](https://github.com/nvm-sh/nvm#installing-and-updating).

```sh
git clone <this-repository-url>
cd <repository-name>
npm i
npm run dev
```
