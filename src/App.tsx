import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { Layout } from './components/Layout';
import { AuthProvider } from './lib/auth';
import { BuilderHome } from './pages/builder/BuilderHome';
import { Editor } from './pages/builder/Editor';
import { NewProtocol } from './pages/builder/NewProtocol';
import { Templates } from './pages/builder/Templates';
import { Audit } from './pages/Audit';
import { Dashboard } from './pages/Dashboard';
import { Digitisation } from './pages/Digitisation';
import { Governance } from './pages/Governance';
import { LineagePage } from './pages/Lineage';
import { Login } from './pages/Login';
import { ExportCenter, Explorer, RelationshipMap, Review, SoaModule } from './pages/Modules';
import { OcrReview } from './pages/OcrReview';
import { Quality } from './pages/Quality';
import { Settings } from './pages/Settings';
import { Studies } from './pages/Studies';
import { UsdmStudio } from './pages/UsdmStudio';
import { VersionsPage } from './pages/Versions';

export function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route element={<Layout />}>
            <Route index element={<Dashboard />} />
            <Route path="studies" element={<Studies />} />
            <Route path="digitisation" element={<Digitisation />} />
            <Route path="digitisation/ocr/:id" element={<OcrReview />} />
            <Route path="builder" element={<BuilderHome />} />
            <Route path="builder/new" element={<NewProtocol />} />
            <Route path="builder/templates" element={<Templates />} />
            <Route path="builder/:id/:tab?" element={<Editor />} />
            <Route path="explorer/:id?" element={<Explorer />} />
            <Route path="soa/:id?" element={<SoaModule />} />
            <Route path="relationships/:id?" element={<RelationshipMap />} />
            <Route path="usdm" element={<UsdmStudio />} />
            <Route path="governance" element={<Governance />} />
            <Route path="lineage" element={<LineagePage />} />
            <Route path="quality" element={<Quality />} />
            <Route path="review/:id?" element={<Review />} />
            <Route path="audit" element={<Audit />} />
            <Route path="versions" element={<VersionsPage />} />
            <Route path="export/:id?" element={<ExportCenter />} />
            <Route path="settings" element={<Settings />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}
