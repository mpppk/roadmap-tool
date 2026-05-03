import { useEffect, useState } from "react";
import { CapacityView } from "./CapacityView";
import { MembersView } from "./MembersView";

export function App() {
  const [path, setPath] = useState(() => window.location.pathname);

  useEffect(() => {
    const handler = () => setPath(window.location.pathname);
    window.addEventListener("popstate", handler);
    return () => window.removeEventListener("popstate", handler);
  }, []);

  if (path === "/members") return <MembersView />;
  return <CapacityView />;
}

export default App;
