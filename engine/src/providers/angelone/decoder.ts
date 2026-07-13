/**
 * Binary decoder for Angel One SmartAPI WebSocket v2 tick frames.
 *
 * Reference layout (little-endian):
 *   byte 0        subscription mode (1=LTP, 2=Quote, 3=SnapQuote)
 *   byte 1        exchange type
 *   bytes 2..26   token (null-padded ASCII, 25 bytes)
 *   bytes 27..34  sequence number (int64)
 *   bytes 35..42  exchange timestamp ms (int64)
 *   bytes 43..46  LTP (int32, divide by 100)
 *   (Quote/SnapQuote continue with more fields — we extract volume & bid/ask)
 */

export interface DecodedTick {
  mode: number;
  exchangeType: number;
  token: string;
  sequence: bigint;
  exchangeTs: number;
  ltp: number;
  volume?: number;
  bestBid?: number;
  bestAsk?: number;
}

export function decodeAngelTick(buf: Buffer): DecodedTick | null {
  if (buf.length < 47) return null;

  const mode = buf.readUInt8(0);
  const exchangeType = buf.readUInt8(1);
  const tokenRaw = buf.slice(2, 27).toString("ascii");
  const token = tokenRaw.replace(/\u0000+$/g, "").trim();
  const sequence = buf.readBigInt64LE(27);
  const exchangeTs = Number(buf.readBigInt64LE(35));
  const ltp = buf.readInt32LE(43) / 100;

  const tick: DecodedTick = { mode, exchangeType, token, sequence, exchangeTs, ltp };

  // Quote mode (2) and SnapQuote (3): more fields follow.
  if (mode >= 2 && buf.length >= 123) {
    // last traded qty (47..54) i64, avg price (55..62) i64/100, volume (63..70) i64,
    // total buy qty (71..78) double, total sell qty (79..86) double,
    // open (87..94) i64/100, high (95..102) i64/100, low (103..110) i64/100, close (111..118) i64/100
    try {
      tick.volume = Number(buf.readBigInt64LE(63));
    } catch {
      /* ignore */
    }
  }

  if (mode === 3 && buf.length >= 379) {
    // best 5 depth begins at offset 147; each entry: qty i32, orders i16, price i32, flag i16 (16 bytes)
    // buy side first (5 entries), then sell side (5 entries)
    try {
      const bidPrice = buf.readInt32LE(147 + 4) / 100;
      const askPrice = buf.readInt32LE(147 + 5 * 16 + 4) / 100;
      tick.bestBid = bidPrice;
      tick.bestAsk = askPrice;
    } catch {
      /* ignore */
    }
  }

  return tick;
}
