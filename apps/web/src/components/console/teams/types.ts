import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@/server/routers";

type RouterOutputs = inferRouterOutputs<AppRouter>;
export type TeamList = RouterOutputs["console"]["teams"]["list"];
export type TeamRow = TeamList["items"][number];
export type TeamDetail = RouterOutputs["console"]["teams"]["detail"];
export type Rung = TeamList["rungs"][number];
export type CodeStep = RouterOutputs["console"]["teams"]["sendSupportViewCode"];
