import { app } from "./app.js";

const port = Number(process.env.MOCK_APP_PORT ?? 4000);
app.listen(port, () => {
  console.log(`[mock-app] Meridian Core Banking mock listening on http://localhost:${port}`);
});
