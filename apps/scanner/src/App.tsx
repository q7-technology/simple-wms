import { BrowserRouter, Navigate, Outlet, Route, Routes } from "react-router-dom";
import { SessionProvider, useSession } from "./auth/Session";
import { SignIn } from "./pages/SignIn";
import { Menu } from "./pages/Menu";
import { Receive } from "./pages/Receive";
import { Move } from "./pages/Move";
import { Count } from "./pages/Count";
import { Lookup } from "./pages/Lookup";
import { Pick } from "./pages/Pick";
import { Pack } from "./pages/Pack";
import { BatchSort } from "./pages/BatchSort";
import { ProductionReceipt } from "./pages/ProductionReceipt";
import { ReceiveTransfer } from "./pages/ReceiveTransfer";
import { Locked } from "./pages/Locked";

function RequireOperator() {
  const { session } = useSession();
  if (!session) return <Navigate to="/sign-in" replace />;
  return <Outlet />;
}

export function App() {
  return (
    <BrowserRouter basename="/scan">
      <SessionProvider>
        <Routes>
          <Route path="/sign-in" element={<SignIn />} />
          <Route path="/locked" element={<Locked />} />
          <Route element={<RequireOperator />}>
            <Route path="/" element={<Menu />} />
            <Route path="/receive" element={<Receive />} />
            <Route path="/receive/:taskId" element={<Receive />} />
            <Route path="/pick" element={<Pick />} />
            <Route path="/pick/:taskId" element={<Pick />} />
            <Route path="/sort" element={<BatchSort />} />
            <Route path="/sort/:ref" element={<BatchSort />} />
            <Route path="/production" element={<ProductionReceipt />} />
            <Route path="/production/:ref" element={<ProductionReceipt />} />
            <Route path="/transfer-in" element={<ReceiveTransfer />} />
            <Route path="/transfer-in/:taskId" element={<ReceiveTransfer />} />
            <Route path="/pack" element={<Pack />} />
            <Route path="/pack/:ref" element={<Pack />} />
            <Route path="/move" element={<Move />} />
            <Route path="/count" element={<Count />} />
            <Route path="/count/:taskId" element={<Count />} />
            <Route path="/lookup" element={<Lookup />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </SessionProvider>
    </BrowserRouter>
  );
}
