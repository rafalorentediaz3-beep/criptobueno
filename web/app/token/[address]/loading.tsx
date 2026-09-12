import { LineSkeleton } from "@/components/Skeletons";

export default function TokenLoading() {
  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <div className="space-y-6 lg:col-span-2">
        <div className="card p-6">
          <LineSkeleton className="h-7 w-56" />
          <LineSkeleton className="mt-3 h-4 w-72" />
        </div>
        <div className="card h-24 p-5">
          <LineSkeleton className="h-5 w-full" />
        </div>
        <div className="card h-80 p-6">
          <LineSkeleton className="h-5 w-28" />
        </div>
      </div>
      <div className="space-y-6">
        <div className="card h-80 p-6">
          <LineSkeleton className="h-5 w-24" />
        </div>
      </div>
    </div>
  );
}
