import React from 'react';

const Header = () => {
  return (
    <div className="container__taujs">
      <a href="https://taujs.dev" target="_blank" title="τjs [taujs]" rel="noreferrer">
        <img src="/taujs.svg" className="logo taujs" alt="τjs logo" />
      </a>
      <h1 className="taujs">τjs [taujs]</h1>
      <h2>Micro-Frontend</h2>
    </div>
  );
};

export default Header;
