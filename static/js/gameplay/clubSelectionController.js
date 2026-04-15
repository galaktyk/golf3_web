/**
 * Owns active-club navigation and the direct-select debug UI wiring.
 */
export function createClubSelectionController({ dom, hud, clubSet, getActiveClub, onSelectClub }) {
  let isClubDetailExpanded = false;

  const updateClubDetailToggleUi = () => {
    if (!dom.clubShell || !dom.clubDetailToggleButton || !dom.clubDetailsPanel) {
      return;
    }

    dom.clubShell.classList.toggle('is-expanded', isClubDetailExpanded);
    dom.clubShell.classList.toggle('is-collapsed', !isClubDetailExpanded);
    dom.clubDetailsPanel.setAttribute('aria-hidden', String(!isClubDetailExpanded));
    dom.clubDetailToggleButton.setAttribute('aria-expanded', String(isClubDetailExpanded));
    dom.clubDetailToggleButton.setAttribute(
      'aria-label',
      isClubDetailExpanded ? 'Hide club details' : 'Show club details',
    );
    dom.clubDetailToggleButton.textContent = isClubDetailExpanded ? '<' : '>';
  };

  const toggleClubDetails = () => {
    isClubDetailExpanded = !isClubDetailExpanded;
    updateClubDetailToggleUi();
  };

  const renderClubDebugButtons = () => {
    if (!dom.clubButtonRow) {
      return;
    }

    dom.clubButtonRow.replaceChildren();

    for (const club of [...clubSet.clubs].reverse()) {
      const clubButton = document.createElement('button');
      clubButton.type = 'button';
      clubButton.className = 'action-button secondary club-direct-button';
      clubButton.textContent = club.id;
      clubButton.dataset.clubId = club.id;
      clubButton.setAttribute('aria-label', `Select ${club.id}`);
      clubButton.setAttribute('aria-pressed', String(club.id === getActiveClub()?.id));
      clubButton.addEventListener('click', () => {
        selectClubById(club.id);
      });
      dom.clubButtonRow.append(clubButton);
    }
  };

  const selectClubById = (clubId) => {
    const nextClub = clubSet.clubs.find((club) => club.id === clubId);
    if (!nextClub) {
      return;
    }

    onSelectClub(nextClub);
  };

  const moveActiveClub = (delta) => {
    const clubIndex = clubSet.clubs.findIndex((club) => club.id === getActiveClub()?.id);
    const nextClubIndex = clubIndex >= 0
      ? Math.min(Math.max(clubIndex + delta, 0), clubSet.clubs.length - 1)
      : 0;
    onSelectClub(clubSet.clubs[nextClubIndex]);
  };

  const initializeClubDebugUi = () => {
    if (!dom.clubPrevButton || !dom.clubNextButton) {
      return;
    }

    renderClubDebugButtons();
    updateClubDetailToggleUi();

    dom.clubPrevButton.addEventListener('click', () => {
      selectPreviousClub();
    });
    dom.clubNextButton.addEventListener('click', () => {
      selectNextClub();
    });
    dom.clubDetailToggleButton?.addEventListener('click', () => {
      toggleClubDetails();
    });

    hud.updateClubDebug(clubSet, getActiveClub());
  };

  const selectPreviousClub = () => {
    moveActiveClub(1);
  };

  const selectNextClub = () => {
    moveActiveClub(-1);
  };

  return {
    initializeClubDebugUi,
    renderClubDebugButtons,
    selectClubById,
    selectNextClub,
    selectPreviousClub,
  };
}