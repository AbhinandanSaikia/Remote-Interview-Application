import { getAuth, clerkClient } from "@clerk/express";
import { sql } from "../config/db.js";

export const protect = async (req, res, next) => {
    try {
        const auth = getAuth(req);
        const userId = auth?.userId || req.auth?.userId;

        if (!userId) {
            return res.status(401).json({ error: "Not authorized, authentication required" });
        }

        req.user = { id: userId };

        const userActivePlan = auth.has({ plan: "premium" }) ? "premium" : "free";

        const users = await sql`SELECT id, name, email, plan FROM users WHERE id = ${userId}`;

        if (users.length === 0) {
            // User authenticated in Clerk but not in database yet (e.g. webhook not set up in local dev)
            let name = "User";
            let email = `${userId}@placeholder.local`;
            let image = "";

            try {
                const clerkUser = await clerkClient.users.getUser(userId);
                name = [clerkUser.firstName, clerkUser.lastName].filter(Boolean).join(" ") || clerkUser.username || "User";
                email = clerkUser.emailAddresses?.find(e => e.id === clerkUser.primaryEmailAddressId)?.emailAddress
                    || clerkUser.emailAddresses?.[0]?.emailAddress
                    || email;
                image = clerkUser.imageUrl || "";
            } catch (clerkErr) {
                console.warn("Could not fetch user profile from Clerk API, using fallback:", clerkErr.message);
            }

            await sql`
                INSERT INTO users (id, name, email, image, plan)
                VALUES (${userId}, ${name}, ${email}, ${image}, ${userActivePlan})
                ON CONFLICT (id) DO UPDATE SET
                    name = EXCLUDED.name,
                    email = COALESCE(NULLIF(EXCLUDED.email, ''), users.email),
                    image = EXCLUDED.image,
                    plan = EXCLUDED.plan,
                    updated_at = NOW()
            `;
        } else {
            const userPlan = users[0]?.plan;
            if (userActivePlan !== userPlan) {
                await sql`UPDATE users SET plan = ${userActivePlan}, updated_at = NOW() WHERE id = ${userId}`;
            }
        }

        next();
    } catch (error) {
        console.error("Auth protect middleware error:", error);
        return res.status(500).json({ error: "Authentication error: " + error.message });
    }
};