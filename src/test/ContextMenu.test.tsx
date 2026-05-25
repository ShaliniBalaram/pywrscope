// src/test/ContextMenu.test.tsx
// Integration test for the new floating context menu (right-click → menu).
// Mounts the real component in jsdom and exercises the click + dismissal paths
// that replaced the previous "right-click silently deletes" behaviour.

import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { ContextMenu, ContextMenuItem } from "../components/ContextMenu";

afterEach(() => cleanup());

function renderMenu(overrides: Partial<{
  items: ContextMenuItem[];
  onClose: () => void;
}> = {}) {
  const onClose = overrides.onClose ?? vi.fn();
  const items = overrides.items ?? [
    { label: "Rename", onClick: vi.fn() },
    { label: "Delete", onClick: vi.fn(), danger: true },
  ];
  render(<ContextMenu x={50} y={50} items={items} onClose={onClose} />);
  return { items, onClose };
}

describe("ContextMenu", () => {
  it("renders every item with its label", () => {
    renderMenu();
    expect(screen.getByText("Rename")).toBeInTheDocument();
    expect(screen.getByText("Delete")).toBeInTheDocument();
  });

  it("clicking an item invokes its onClick AND closes the menu", () => {
    const onClose = vi.fn();
    const renameClick = vi.fn();
    const deleteClick = vi.fn();
    renderMenu({
      onClose,
      items: [
        { label: "Rename", onClick: renameClick },
        { label: "Delete", onClick: deleteClick, danger: true },
      ],
    });

    fireEvent.click(screen.getByText("Delete"));
    expect(deleteClick).toHaveBeenCalledOnce();
    expect(renameClick).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("Escape closes the menu", () => {
    const onClose = vi.fn();
    renderMenu({ onClose });
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("clicking outside closes the menu", () => {
    const onClose = vi.fn();
    renderMenu({ onClose });
    // mousedown on document body — outside the menu's ref
    fireEvent.mouseDown(document.body);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("clamps position so the menu stays in the viewport", () => {
    const onClose = vi.fn();
    // window.innerWidth/Height in jsdom default to 1024x768
    render(
      <ContextMenu
        x={9999}
        y={9999}
        items={[{ label: "X", onClick: vi.fn() }]}
        onClose={onClose}
      />,
    );
    const menu = screen.getByText("X").parentElement!;
    const left = parseFloat(menu.style.left);
    const top = parseFloat(menu.style.top);
    expect(left).toBeLessThan(window.innerWidth);
    expect(top).toBeLessThan(window.innerHeight);
  });

  it("renders danger items in a different colour than safe items", () => {
    renderMenu({
      items: [
        { label: "Safe", onClick: vi.fn() },
        { label: "Danger", onClick: vi.fn(), danger: true },
      ],
    });
    const safeBtn = screen.getByText("Safe") as HTMLButtonElement;
    const dangerBtn = screen.getByText("Danger") as HTMLButtonElement;
    expect(safeBtn.style.color).not.toBe(dangerBtn.style.color);
  });
});
