import { CUSTOMER_TEXT_MAX, isPlainName } from "@millionsend/core";
import { z } from "zod";

/** A team name as creating or renaming a team stores it: a plain name (isPlainName). */
export const teamNameSchema = z.string().trim().min(1).max(CUSTOMER_TEXT_MAX).refine(isPlainName);
