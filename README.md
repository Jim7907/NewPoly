# Polymarket Weather Arbitrage Bot

Compares ECMWF + NOAA GFS + DWD ICON weather ensemble against live Polymarket prices
at exact resolution station coordinates (not city centroids).

## Quick Start

```bash
git clone https://github.com/YOUR_USERNAME/polymarket-weather-bot
cd polymarket-weather-bot
cp .env.example .env
docker-compose up --build -d
open http://localhost:3001
```

## Local Dev

```bash
npm install
npm run dev
# Frontend: http://localhost:3000
# API:      http://localhost:3001
```

## API Endpoints

| Endpoint | Description |
|---|---|
| GET /api/health | Server health |
| GET /api/stations | Resolution stations list |
| GET /api/ensemble/:stationId | 3-model weather ensemble |
| GET /api/polymarket/markets | Live weather markets |
| GET /api/polymarket/price/:tokenId | Live YES price |
| GET /api/scan/:stationId | Full edge scan for station |
| GET /api/scan-all | Scan all stations |

## Resolution Stations (exact coords Polymarket uses)

| City | Station ID | Location |
|---|---|---|
| New York (temp) | KLGA | LaGuardia Airport |
| London | EGLC | London City Airport |
| Miami | KMIA | Miami International |
| Chicago | KORD | O Hare Airport |
| Los Angeles | KLAX | LAX Airport |
| Hong Kong | VHHH | HK International |

## Live Trading

Add keys to .env (generate at polymarket.com -> Profile -> API):
```
POLY_API_KEY=your_key
POLY_SECRET=your_secret
POLY_PASSPHRASE=your_passphrase
```
Then toggle Paper Mode OFF in the UI.
