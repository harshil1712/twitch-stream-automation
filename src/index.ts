import { Hono } from "hono";
import { xAuth, refreshToken } from "@hono/oauth-providers/x";
import { env } from "cloudflare:workers";
import { AtpAgent, RichText } from "@atproto/api";

const app = new Hono<{ Bindings: CloudflareBindings }>();

const refreshXToken = async (c: any) => {
  try {
    const refreshTokenKv = await c.env.KV.get("x_refresh_token");
    if (!refreshTokenKv) {
      throw new Error("No refresh token found");
    }

    const tokens = await refreshToken(
      c.env.X_CLIENT_ID,
      c.env.X_CLIENT_SECRET,
      refreshTokenKv
    );

    await c.env.KV.put("x_access_token", tokens.access_token);
    if (tokens.refresh_token) {
      await c.env.KV.put("x_refresh_token", tokens.refresh_token);
    }

    return tokens.access_token;
  } catch (error) {
    console.error("Failed to refresh token:", error);
    throw new Error("Token refresh failed");
  }
};

const postOnX = async (post: string, accessToken: string, c: any) => {
  const xUrl = "https://api.x.com/2/tweets";
  try {
    let response = await fetch(xUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text: post,
      }),
    });

    // If unauthorized, try refreshing the token
    if (response.status === 401) {
      const newToken = await refreshXToken(c);
      response = await fetch(xUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${newToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          text: post,
        }),
      });
    }

    const result = await response.json();
    if (!response.ok) {
      throw new Error(JSON.stringify(result));
    }
    return result;
  } catch (error) {
    console.error(error);
    // throw new Error("Error posting on X");
  }
};

// Post on Bluesky
const postOnBsky = async (post: string, c: any) => {
  const agent = new AtpAgent({
    service: "https://bsky.social",
  });

  await agent.login({
    identifier: c.env.BSKY_USERNAME,
    password: c.env.BSKY_PASSWORD,
  });

  const richText = new RichText({ text: post });

  await richText.detectFacets(agent);

  await agent.post({
    text: richText.text,
    facets: richText.facets,
    $type: "app.bsky.feed.post",
    createdAt: new Date().toISOString(),
  });
};

// Twitter Authentication
app.get(
  "/auth/x",
  xAuth({
    client_id: env.X_CLIENT_ID,
    client_secret: env.X_CLIENT_SECRET,
    scope: ["tweet.write", "users.read", "offline.access", "tweet.read"],
    fields: ["id", "username"],
  }),
  async (c) => {
    const token = c.get("token");
    const refresh_token = c.get("refresh-token");
    const user = c.get("user-x");

    if (!token || !refresh_token || !user) {
      return c.text("Failed to authenticate with X", 401);
    }

    // Check if the authenticated user is the allowed user
    if (user.username !== c.env.ALLOWED_X_USERNAME) {
      return c.text("Unauthorized user", 403);
    }

    // Store the tokens in KV
    await c.env.KV.put("x_access_token", token.token);
    await c.env.KV.put("x_refresh_token", refresh_token.token);
    return c.json({ token, user });
  }
);

// Twitch Live Announcement
app.post("/api/live-announcement", async (c) => {
  const data = await c.req.json();
  let title = "";
  let description = "";
  const TWITCH_API = `https://api.twitch.tv/helix/videos?user_id=${c.env.TWITCH_USER_ID}&first=2&sort=time&period=day`;
  if (data && data.challenge) {
    return c.text(data.challenge);
  }
  if (data && data.subscription.type === "stream.online") {
    const videoData = await fetch(TWITCH_API, {
      headers: {
        "Client-ID": `${c.env.TWITCH_CLIENT_ID}`,
        Authorization: `Bearer ${c.env.TWITCH_APP_ACCESS_TOKEN}`,
      },
    });
    if (videoData.ok) {
      const video = (await videoData.json()) as any;
      title = video.data[0].title;
      description = video.data[0].description;
    }
    // Get stored access token
    const accessToken = await c.env.KV.get("x_access_token");
    if (!accessToken) {
      return c.text("Not authenticated with X", 401);
    }
    const messages = [
      {
        role: "system",
        content: `You are a friendly assistant. You help me create social media posts. You will create social media posts everytime I do a live stream, encouraging folks to tune-in.  I'll provide you with the title and the description of the livestream. Keep the post short and fun! These are tech live streams.
        If no title and description is provided, you should make a general post eg. "I'm live! Come hang out with me!".
        
        ONLY RETURN THE POST. NO OTHER MESSAGE. JUST THE POST CONTENT. Whereever appropriate, add a new line and emojis. Do not overuse emojis.
        Use this Live Stream links: 
        - Twitch: https://twitch.tv/harshil1712
        - YouTube: https://youtube.com/@harshil1712
      `,
      },
      {
        role: "user",
        content: `Title: ${title}
        Description: ${description}`,
      },
    ];
    const response = await c.env.AI.run(
      "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
      { messages },
      {
        gateway: {
          id: "fun_prod",
          skipCache: false,
        },
      }
    );

    if (!response) {
      const tweet = `Join me LIVE on Twitch (https://twitch.tv/harshil1712) or YouTube (https://youtube.com/@harshil1712) as we dive back into Cloudflare Workers!
Don't miss out on the techy goodness! Tune in now!
#Cloudflare #LiveStream #Tech`;
      const formattedPost = tweet
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .join("\n");
      await postOnX(formattedPost, accessToken, c);
      await postOnBsky(formattedPost, c);
      return c.text("No response from AI");
    }

    // Format the AI response to handle newlines properly
    const formattedAIResponse = response.response
      .split("\n")
      .map((line: string) => line.trim())
      .filter((line: string) => line.length > 0)
      .join("\n");

    await postOnX(formattedAIResponse, accessToken, c);
    await postOnBsky(formattedAIResponse, c);
    return c.text(title);
  }
  return c.json({ data });
});

export default app;
