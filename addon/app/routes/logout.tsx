import { type ActionFunctionArgs, type LoaderFunctionArgs, redirect } from "@remix-run/node";
import { logout } from "~/lib/session.server";

export async function action({ request }: ActionFunctionArgs) {
  return logout(request);
}
export async function loader(_: LoaderFunctionArgs) {
  return redirect("/login");
}
