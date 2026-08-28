import "@oh-my-pi/collab-web/styles/base.css";
import "./styles/tokens.css";
import "./styles/motion.css";
import "./styles/app.css";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { DesktopClient } from "./desktop-client";
import { createThemeController } from "./theme";

createThemeController(document.documentElement);

const mount = document.getElementById("root");
if (mount === null) throw new Error("Missing #root mount point");

const client = new DesktopClient();
client.connect();
window.addEventListener("beforeunload", () => client.close(), { once: true });

createRoot(mount).render(
	<StrictMode>
		<App client={client} />
	</StrictMode>,
);
