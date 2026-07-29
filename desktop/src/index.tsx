/* @refresh reload */
import { render } from "solid-js/web";
import App from "./App";
import "./styles/theme.css";
import "./styles/base.css";

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");

render(() => <App />, root);
