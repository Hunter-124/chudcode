import "@oh-my-pi/collab-web/styles/base.css";
import "../../../chudcode-desktop/src/web/styles/tokens.css";
import "../../../chudcode-desktop/src/web/styles/motion.css";
import "../../../chudcode-desktop/src/web/styles/app.css";
import "../../../collab-web/src/components/shell/shell.css";
import "./styles.css";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { DesktopClient } from "../../../chudcode-desktop/src/web/desktop-client";
import { WorkbenchBridge } from "./bridge";
import { WorkbenchPanel } from "./WorkbenchPanel";

const mount = document.getElementById("root");
if (!mount) throw new Error("Missing workbench webview root");
document.documentElement.dataset.density = "compact";

const bridge = new WorkbenchBridge();
const client = new DesktopClient({
	location: { protocol: "http:", host: "127.0.0.1", search: "" },
	webSocketFactory: bridge.createSocket,
});

createRoot(mount).render(
	<StrictMode>
		<WorkbenchPanel client={client} bridge={bridge} />
	</StrictMode>,
);
client.connect();
window.addEventListener(
	"beforeunload",
	() => {
		client.close();
		bridge.dispose();
	},
	{ once: true },
);
