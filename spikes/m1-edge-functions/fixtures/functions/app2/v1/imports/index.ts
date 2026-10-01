import { z } from "zod";

Deno.serve(() => Response.json({ parsed: z.string().parse("bare specifier via deno.json") }));
