/* @refresh reload */
import { render } from "solid-js/web";
import App from "./App";
import "./styles/theme.css";
import "./styles/base.css";
// Last: motion tokens are read by base/theme rules, and the reduced-motion
// override has to be able to win over anything either of them declares.
import "./styles/motion.css";

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");

render(() => <App />, root);
