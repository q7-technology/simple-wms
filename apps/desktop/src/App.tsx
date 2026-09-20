import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { AuthProvider } from "./auth/AuthContext";
import { RequireAuth } from "./auth/RequireAuth";
import { Shell } from "./ui/Shell";
import { SignIn } from "./pages/SignIn";
import { Stock } from "./pages/Stock";
import { Locations } from "./pages/Locations";
import { Products } from "./pages/Products";
import { Integrations } from "./pages/Integrations";
import { Settings } from "./pages/Settings";
import { Users } from "./pages/Users";
import { TaskBoard } from "./pages/TaskBoard";
import { Receiving } from "./pages/Receiving";
import { Replenishment } from "./pages/Replenishment";
import { ImportExport } from "./pages/ImportExport";

export function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/sign-in" element={<SignIn />} />
          <Route element={<RequireAuth />}>
            <Route element={<Shell />}>
              <Route index element={<Navigate to="/stock" replace />} />
              <Route path="/tasks" element={<TaskBoard />} />
              <Route path="/receiving" element={<Receiving />} />
              <Route path="/replenishment" element={<Replenishment />} />
              <Route path="/import" element={<ImportExport />} />
              <Route path="/stock" element={<Stock />} />
              <Route path="/locations" element={<Locations />} />
              <Route path="/products" element={<Products />} />
              <Route path="/integrations" element={<Integrations />} />
              <Route path="/users" element={<Users />} />
              <Route path="/settings" element={<Settings />} />
              <Route path="*" element={<Navigate to="/stock" replace />} />
            </Route>
          </Route>
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}
