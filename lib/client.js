window.__ModuleLoader__.load({ id: "dsh-delete-archived", factory: (require) => {
	var module = { exports: {} };
	var exports = module.exports;
	var react = require("react");

	/** Required Client service: the slot registry. */
	var inject = ["slots"];

	/**
	 * Menu-row styling, copied from the host `MenuItemButton` item/itemLabel
	 * rules and renamed under this plugin's own prefix. Only `--dsw-alias-*`
	 * theme tokens are referenced, so light/dark themes inherit automatically.
	 */
	var CSS = [
		".dda-item-wrap{position:relative}",
		".dda-item{display:flex;align-items:center;gap:6px;width:100%;min-height:34px;padding:6px 8px;border:none;border-radius:var(--dsw-radius-md);background:transparent;cursor:pointer;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary);text-align:left}",
		".dda-item:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}",
		".dda-item:focus-visible:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);outline:none}",
		".dda-item.dda-danger{color:var(--dsw-alias-state-error-primary)}",
		".dda-item.dda-danger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger)}",
		".dda-item.dda-danger:focus-visible:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger);outline:none}",
		".dda-item-label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
	].join("\n");

	/**
	 * One destructive "delete this archived conversation" row inside a Session's
	 * "..." menu. Two-step confirm: first click arms ("确认删除"), second performs
	 * the Host deletion (a same-origin POST) and dismisses the menu; a refusal
	 * re-arms with the Host message inline.
	 *
	 * The sidebar slot does not expose the archived set to third-party entries,
	 * so this row asks the Host /list route whether this sessionId is archived and
	 * hides itself otherwise (including while the answer is still loading). The
	 * Host-side guard remains the authoritative check.
	 */
	function DeleteArchivedMenuItem(props) {
		var sessionId = props.sessionId;
		var useMenuOpenState = props.useMenuOpenState;
		var setMenuOpen = useMenuOpenState()[1];

		var phaseState = react.useState(0); // 0 idle · 1 armed · 2 busy · 3 failed
		var phase = phaseState[0];
		var setPhase = phaseState[1];
		var errorState = react.useState("");
		var errorText = errorState[0];
		var setErrorText = errorState[1];

		// null = loading, true/false once the Host answered the /list route.
		var archivedState = react.useState(null);
		var archived = archivedState[0];
		var setArchived = archivedState[1];

		react.useEffect(function () {
			var cancelled = false;
			fetch("/plugin/dsh-delete-archived/list")
				.then(function (response) { return response.json(); })
				.then(function (data) {
					if (cancelled) return;
					var list = data && Array.isArray(data.sessions) ? data.sessions : [];
					var found = false;
					for (var i = 0; i < list.length; i++) {
						if (list[i].sessionId === sessionId) { found = true; break; }
					}
					setArchived(found);
				})
				.catch(function () {
					if (!cancelled) setArchived(false);
				});
			return function () { cancelled = true; };
		}, [sessionId]);

		// All hooks above run unconditionally; this early return keeps React's
		// hook order stable and hides the row for non-archived sessions.
		if (archived !== true) return null;

		var label;
		if (phase === 1) label = "确认删除该对话（不可恢复）";
		else if (phase === 2) label = "正在删除…";
		else if (phase === 3) label = "删除失败：" + errorText + "（点击重试）";
		else label = "删除对话";

		return react.createElement("div", { className: "dda-item-wrap" },
			react.createElement("button", {
				type: "button",
				role: "menuitem",
				className: "dda-item dda-danger",
				onClick: function () {
					if (phase === 2) return;
					if (phase !== 1) {
						setPhase(1);
						setErrorText("");
						return;
					}
					setPhase(2);
					fetch("/plugin/dsh-delete-archived/delete", {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ sessionId: sessionId }),
					}).then(function (response) {
						return response.json().then(function (data) {
							if (!response.ok) {
								throw new Error(data && data.message ? String(data.message) : "HTTP " + response.status);
							}
							return data;
						});
					}).then(function () {
						setMenuOpen(false);
					}, function (error) {
						var message = error && error.message ? String(error.message) : String(error);
						setErrorText(message);
						setPhase(3);
					});
				},
			}, react.createElement("span", { className: "dda-item-label" }, label)));
	}

	/**
	 * Register the delete entry into the sidebar's per-Session "..." menu, plus
	 * the plugin's own style block. Synchronous: no Remote namespace mount, no
	 * async handshake.
	 */
	function apply(ctx) {
		ctx.effect(function () {
			var tag = document.createElement("style");
			tag.dataset.plugin = "dsh-delete-archived";
			tag.textContent = CSS;
			document.head.appendChild(tag);
			return function () { tag.remove(); };
		}, "dsh-delete-archived: css");

		ctx.slots.inject("sidebar.workspaces.session.menu.item", function () {
			return ctx.slots.register({
				name: "sidebar.workspaces.session.menu.item",
				id: "dsh-delete-archived.menu",
				order: 500,
			}, DeleteArchivedMenuItem);
		});
	}

	module.exports = { inject: inject, apply: apply };
	return module.exports;
}});
