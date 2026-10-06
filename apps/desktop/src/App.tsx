import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { AuthProvider } from "./auth/AuthContext";
import { RequireAuth } from "./auth/RequireAuth";
import { Shell } from "./ui/Shell";
import { SignIn } from "./pages/SignIn";
import { SsoReturn } from "./pages/SsoReturn";
import { Home } from "./pages/Home";
import { Menu } from "./pages/Menu";
import { Stock } from "./pages/Stock";
import { Locations } from "./pages/Locations";
import { Products } from "./pages/Products";
import { Integrations } from "./pages/Integrations";
import { Printing } from "./pages/Printing";
import { Settings } from "./pages/Settings";
import { Users } from "./pages/Users";
import { TaskBoard } from "./pages/TaskBoard";
import { Receiving } from "./pages/Receiving";
import { Replenishment } from "./pages/Replenishment";
import { ImportExport } from "./pages/ImportExport";
import { Deliveries } from "./pages/Deliveries";
import { DeliveryDetail } from "./pages/DeliveryDetail";
import { BatchPick } from "./pages/BatchPick";
import { Production } from "./pages/Production";
import { Transfers } from "./pages/Transfers";
import { Containers } from "./pages/Containers";
import { Owners } from "./pages/Owners";
import { Reports } from "./pages/Reports";

/** Every route. The map is home; every other panel opens in a drawer over it. */
export function AppRoutes() {
  return (
    <Routes>
      <Route path="/sign-in" element={<SignIn />} />
      <Route path="/sso" element={<SsoReturn />} />
      <Route element={<RequireAuth />}>
        <Route element={<Shell />}>
          <Route index element={<Home />} />
          <Route path="/menu" element={<Menu />} />
          <Route path="/deliveries" element={<Deliveries />} />
          <Route path="/deliveries/batches" element={<BatchPick />} />
          <Route path="/deliveries/:ref" element={<DeliveryDetail />} />
          <Route path="/production" element={<Production />} />
          <Route path="/transfers" element={<Transfers />} />
          <Route path="/tasks" element={<TaskBoard />} />
          <Route path="/receiving" element={<Receiving />} />
          <Route path="/replenishment" element={<Replenishment />} />
          <Route path="/import" element={<ImportExport />} />
          <Route path="/stock" element={<Stock />} />
          <Route path="/containers" element={<Containers />} />
          <Route path="/owners" element={<Owners />} />
          <Route path="/reports" element={<Reports />} />
          <Route path="/locations" element={<Locations />} />
          <Route path="/products" element={<Products />} />
          <Route path="/integrations" element={<Integrations />} />
          <Route path="/printing" element={<Printing />} />
          <Route path="/users" element={<Users />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Route>
    </Routes>
  );
}

export function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <AppRoutes />
      </AuthProvider>
    </BrowserRouter>
  );
}
