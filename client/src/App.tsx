import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { RequireAuth } from "@/components/AppShell";
import { AuthProvider } from "@/contexts/AuthContext";
import { ActivityPage, AuthPage, ChatPage, ChatsPage, DatePage, ExplorePage, MyProfilePage, NotFoundPage, OnboardingPage, PeoplePage, ProfilePage, RequestsPage } from "@/pages/ProductPages";
import { Route, Switch } from "wouter";
import ErrorBoundary from "./components/ErrorBoundary";

function Router() {
  return (
    <Switch>
      <Route path="/" component={ExplorePage} />
      <Route path="/activity/:id">{({ id }) => <ActivityPage id={id} />}</Route>
      <Route path="/activity/:id/people">{({ id }) => <PeoplePage id={id} />}</Route>
      <Route path="/profile/:id">{({ id }) => <RequireAuth><ProfilePage id={id} /></RequireAuth>}</Route>
      <Route path="/auth" component={AuthPage} />
      <Route path="/onboarding"><RequireAuth><OnboardingPage /></RequireAuth></Route>
      <Route path="/requests"><RequireAuth><RequestsPage /></RequireAuth></Route>
      <Route path="/chats"><RequireAuth><ChatsPage /></RequireAuth></Route>
      <Route path="/chats/:id">{({ id }) => <RequireAuth><ChatPage id={id} /></RequireAuth>}</Route>
      <Route path="/date/:id">{({ id }) => <RequireAuth><DatePage conversationId={id} /></RequireAuth>}</Route>
      <Route path="/me"><RequireAuth><MyProfilePage /></RequireAuth></Route>
      <Route component={NotFoundPage} />
    </Switch>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <AuthProvider>
        <TooltipProvider>
          <Toaster />
          <Router />
        </TooltipProvider>
      </AuthProvider>
    </ErrorBoundary>
  );
}
