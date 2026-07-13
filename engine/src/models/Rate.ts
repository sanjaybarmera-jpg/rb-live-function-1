export interface Rate {
  symbol: string;
  ltp: number;
  bid?: number;
  ask?: number;
  ts: string;
}
