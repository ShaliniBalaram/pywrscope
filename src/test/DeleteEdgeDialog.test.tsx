// src/test/DeleteEdgeDialog.test.tsx
// Integration test for the new edge-delete confirmation dialog.

import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { DeleteEdgeDialog } from "../components/DeleteEdgeDialog";

afterEach(() => cleanup());

describe("DeleteEdgeDialog", () => {
  it("displays both endpoint names in the prompt", () => {
    render(
      <DeleteEdgeDialog from="A" to="B" onConfirm={vi.fn()} onCancel={vi.fn()} />,
    );
    expect(screen.getByText(/"A" → "B"/)).toBeInTheDocument();
  });

  it("Delete button calls onConfirm", () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(<DeleteEdgeDialog from="A" to="B" onConfirm={onConfirm} onCancel={onCancel} />);
    fireEvent.click(screen.getByText("Delete"));
    expect(onConfirm).toHaveBeenCalledOnce();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("Cancel button calls onCancel only", () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(<DeleteEdgeDialog from="A" to="B" onConfirm={onConfirm} onCancel={onCancel} />);
    fireEvent.click(screen.getByText("Cancel"));
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("clicking the backdrop cancels the dialog", () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const { container } = render(
      <DeleteEdgeDialog from="A" to="B" onConfirm={onConfirm} onCancel={onCancel} />,
    );
    // The outermost div is the backdrop (position: fixed, inset: 0)
    const backdrop = container.firstChild as HTMLElement;
    fireEvent.click(backdrop);
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("clicking inside the dialog body does NOT cancel", () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(<DeleteEdgeDialog from="A" to="B" onConfirm={onConfirm} onCancel={onCancel} />);
    // Click on the heading text — inside the dialog body, should be a no-op
    fireEvent.click(screen.getByText("Delete edge"));
    expect(onCancel).not.toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("shows the post-fix copy: ⌘Z to undo, not 'cannot be undone'", () => {
    render(<DeleteEdgeDialog from="A" to="B" onConfirm={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByText(/⌘Z to undo/i)).toBeInTheDocument();
    expect(screen.queryByText(/cannot be undone/i)).not.toBeInTheDocument();
  });
});
