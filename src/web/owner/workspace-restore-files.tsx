// The files a backup holds, with what the restore does to each. Shown under Details in
// the restore's last step, so the owner can read it without it crowding the choice.
import {
  formatBytes,
  type WorkspaceRestorePreview,
} from "./workspace-restore-api";

export function FileList({
  files,
}: {
  files: WorkspaceRestorePreview["files"];
}) {
  if (files.length === 0)
    return <p className="small muted">The backup holds no files.</p>;
  return (
    <table>
      <thead>
        <tr>
          <th scope="col">File</th>
          <th scope="col">Size</th>
          <th scope="col">On restore</th>
        </tr>
      </thead>
      <tbody>
        {files.map((file) => (
          <tr key={file.path}>
            <td className="mono">{file.path}</td>
            <td>{formatBytes(file.size)}</td>
            <td>{file.restorable ? "Restored" : "Not restored"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
