import type { RateBroadcaster } from "../services/RateBroadcaster.js";
import { logger } from "../utils/logger.js";
import { toIso } from "../utils/time.js";
import { getSupabase } from "./supabase.js";
import type { Tick } from "../models/Tick.js";
import {
  metalGroupForSymbol,
  metalTypesForGroup,
  type MetalGroup,
} from "./metals.js";
import { currentSessionKey, sessionKeyFor } from "./session.js";
import { sanitizeExpiryDate } from "../utils/expiry.js";
import {
  recordLtpObservation,
  recordMappingFailure,
  recordTick,
  recordWriteAttempt,
  recordWriteFailure,
  recordWriteSuccess,
  recordZeroRowUpdate,
  setPendingLatestTick,
} from "./feedDiagnostics.js";

// Existing declarations and implementation remain unchanged except for the
// optional broadcaster dependency and the publish call after a successful DB write.
