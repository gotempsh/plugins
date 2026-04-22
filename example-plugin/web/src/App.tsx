import { useRoute } from "./router";
import { ReportList } from "./components/ReportList";
import { ReportDetail } from "./components/ReportDetail";
import { PageDetail } from "./components/PageDetail";
import { Settings } from "./components/Settings";

export function App() {
  const route = useRoute();

  switch (route.kind) {
    case "list":
      return <ReportList />;
    case "report":
      return <ReportDetail reportId={route.reportId} />;
    case "page":
      return <PageDetail reportId={route.reportId} pageUrl={route.pageUrl} />;
    case "settings":
      return <Settings />;
  }
}
